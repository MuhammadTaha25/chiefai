import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail, mailgunDomainForAddress, getMailboxReadiness } from "@/lib/mailgun";
import { classifyReply, draftReplyEmail, generateMeetingTopic, type ReplySentiment } from "@/lib/gemini";
import { isUnsubscribeRequest, unsubscribeConfirmation, isAutomatedMessage } from "@/lib/compliance";
import { insertOutreachLog, REPLY_TOUCH_NUMBER } from "@/lib/outreach-log";
import { logEvent } from "@/lib/log-event";
import { verifyMailgunSignature } from "@/lib/webhook-security";
import { buildEmailHistory } from "@/lib/email-history";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";
import { classifyMailboxMatch } from "@/lib/mailbox-match";

/**
 * Classifies an inbound reply with Gemini (real AI, 4-way: BOOKING / HAPPY /
 * ANGRY / UNCLEAR — see FINAL MASTER PROMPT §14) and sends a tone-matched
 * reply. AI only classifies; every state transition below (reply_received,
 * suppression, next_follow_up_at) is decided by this deterministic code, not
 * the model itself.
 *
 * An explicit unsubscribe/stop request is checked FIRST, deterministically
 * (see lib/compliance.ts) — never delegated to the AI classification call,
 * since a missed unsubscribe means continuing to email someone who
 * explicitly opted out. This also covers the "explicit opt-out inside an
 * ANGRY reply" case (§19/ANGRY branch): the deterministic check runs before
 * classification even happens, so an angry reply that also says "remove me"
 * is caught here regardless of what the AI would have said.
 *
 * Dedup mirrors social_reply_log's pattern but reuses the existing
 * `processed_inbound_messages` table, keyed by Mailgun's Message-Id, so a
 * redelivered webhook never double-processes a reply (spec: duplicate
 * inbound webhook -> one reply state update, one AI call, no duplicate
 * auto-response).
 *
 * The dedup row is inserted before any processing, so everything from that
 * point on is wrapped in try/catch and always returns 200 — an uncaught
 * throw here would make Mailgun retry-deliver, and a retry after the dedup
 * row already exists would just silently no-op instead of actually
 * completing the work, permanently losing that reply.
 */
// `leads.status` has its own check constraint (confirmed live: "booking_intent"
// and "booked" both 400) — reuse the pre-existing allowed vocabulary rather
// than inventing new status strings that silently break every update.
const STATUS_FOR_CLASSIFICATION: Record<ReplySentiment, string> = {
  BOOKING: "booking",
  HAPPY: "positive",
  ANGRY: "angry",
  UNCLEAR: "responded",
};

// `leads.sentiment` has its own, narrower legacy check constraint (only
// positive/angry/neutral — confirmed live). The full 4-way classification is
// preserved verbatim in `reply_classification`; this column just keeps
// existing code/UI that reads `sentiment` working without another migration
// widening that constraint.
const SENTIMENT_COLUMN_VALUE: Record<ReplySentiment, string> = {
  BOOKING: "positive",
  HAPPY: "positive",
  ANGRY: "angry",
  UNCLEAR: "neutral",
};

/** Campaign-level reply_count is a rollup for the Campaigns dashboard — bumped once per genuine inbound reply. */
async function incrementCampaignReplyCount(admin: ReturnType<typeof createAdminClient>, campaignId: string | null) {
  if (!campaignId) return;
  const { data: campaign } = await admin.from("campaigns").select("reply_count").eq("id", campaignId).maybeSingle<{
    reply_count: number;
  }>();
  await admin
    .from("campaigns")
    .update({ reply_count: (campaign?.reply_count ?? 0) + 1 })
    .eq("id", campaignId);
}

/** Replies arrive at the Mailgun subdomain form (sales@sales.example.com); mailboxes are stored as sales@example.com. */
function mailboxAddressForRecipient(recipient: string): string {
  const m = recipient.match(/^([^@]+)@([^@]+)$/);
  if (m && m[2].startsWith(`${m[1]}.`)) return `${m[1]}@${m[2].slice(m[1].length + 1)}`;
  return recipient;
}

const MAX_AUTO_REPLIES_PER_LEAD = 3;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // A malformed/empty POST used to throw here and surface as a 500, which
    // makes Mailgun retry a request that can never succeed.
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const timestamp = String(form.get("timestamp") ?? "");
  const token = String(form.get("token") ?? "");
  const signature = String(form.get("signature") ?? "");
  // Fail-closed: previously a request with no signature fields at all skipped
  // verification entirely (and the signing key was never configured), so any
  // party could POST a forged "inbound reply" and trigger AI replies /
  // unsubscribes for real leads. Now a valid Mailgun signature is mandatory.
  if (!verifyMailgunSignature(timestamp, token, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const messageId = String(form.get("Message-Id") ?? form.get("message-id") ?? "");
  const sender = String(form.get("sender") ?? form.get("from") ?? "");
  const recipient = String(form.get("recipient") ?? "").trim().toLowerCase();
  const bodyPlain = String(form.get("body-plain") ?? "");
  // Mailgun's own quote-stripped reply text (excludes the quoted original
  // underneath, including our "reply unsubscribe" footer) — unsubscribe
  // detection must only look at what the lead actually typed, never at
  // quoted text from our own outbound email. Falls back to bodyPlain only
  // if Mailgun didn't supply it (older/custom inbound configs).
  const bodyStripped = String(form.get("stripped-text") ?? "") || bodyPlain;
  const inReplyTo = String(form.get("In-Reply-To") ?? form.get("in-reply-to") ?? "");
  const inboundSubject = String(form.get("Subject") ?? form.get("subject") ?? "");

  if (!messageId || !sender) {
    return NextResponse.json({ error: "Missing sender or Message-Id" }, { status: 400 });
  }
  if (!recipient) {
    // Every real inbound route delivers this — without it we cannot safely
    // resolve which tenant's mailbox received the reply, and matching the
    // lead globally by email risks attributing a reply to the wrong client
    // if two clients' leads ever share an address.
    return NextResponse.json({ error: "Missing recipient" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: alreadyProcessed } = await admin
    .from("processed_inbound_messages")
    .select("message_id")
    .eq("message_id", messageId)
    .maybeSingle();

  if (alreadyProcessed) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  // leads.email is always stored lowercase (see campaigns/create dedup) but
  // an inbound From header can arrive in any case a real mail client sent it
  // in — matching without normalizing silently drops the reply as
  // "matched_lead: false" for any lead whose actual mailbox has mixed case,
  // which is exactly the kind of bug that looks like "replies aren't
  // appearing" without ever surfacing an error.
  const senderEmail = (sender.match(/<(.+)>/)?.[1] ?? sender.trim()).toLowerCase();
  // The insert IS the claim: message_id is UNIQUE, so of several concurrent deliveries of the same
  // message (Mailgun retries slow responses) exactly one wins and the rest stop here. A plain
  // "select then insert" let two deliveries both pass and both auto-reply.
  const { error: claimError } = await admin.from("processed_inbound_messages").insert({ message_id: messageId, thread_key: senderEmail });
  if (claimError) {
    if (claimError.code === "23505") return NextResponse.json({ ok: true, deduped: true });
    // Could not record the message: fail closed (5xx makes Mailgun retry) rather than risk double-processing.
    return NextResponse.json({ error: "Could not record inbound message" }, { status: 500 });
  }

  try {
    // Resolve tenant from the mailbox that actually received this reply —
    // never from the sender email alone. This is the multi-tenant boundary:
    // a lead lookup scoped only by email could match a different client's
    // lead if two clients' Vibe Prospecting results ever overlap on the same
    // contact address.
    // P0 SECURITY FIX (Existing-Domain Feature Audit, 2026-10-09): `mailboxes`
    // is only unique per (client_id, address), not per address alone, so two
    // different clients could have a row for the identical address (e.g. a
    // cross-tenant domain-ownership collision pre-dating the ownership
    // gate). .maybeSingle() on a query that matches 2+ rows returns an error
    // the old code never checked, meaning an ambiguous match silently fell
    // through as "not found" — risking a reply landing on the wrong tenant
    // (or neither) with no record of why. Fetch up to 2 explicitly instead,
    // so "ambiguous" is its own loud, logged case, never conflated with
    // "no mailbox matched" or silently treated as handled.
    const { data: matchingMailboxes } = await admin
      .from("mailboxes")
      .select("id, client_id, address")
      .ilike("address", mailboxAddressForRecipient(recipient))
      .limit(2)
      .returns<{ id: string; client_id: string; address: string }[]>();

    const match = classifyMailboxMatch(matchingMailboxes ?? []);
    if (match.kind === "none") {
      // eslint-disable-next-line no-console
      console.error(`Mailgun inbound webhook: no mailbox row matches recipient ${recipient}`);
      return NextResponse.json({ ok: true, matched_mailbox: false });
    }
    if (match.kind === "ambiguous") {
      // Never guess which tenant should receive an ambiguous reply, and
      // never report success for it — this must be visible for manual
      // review (it indicates a cross-tenant mailbox-address collision that
      // the ownership gate should now prevent going forward, but may still
      // exist from before it shipped).
      logEvent("mailgun.inbound_ambiguous_mailbox", {
        recipient,
        client_ids: match.rows.map((m) => m.client_id).join(","),
      });
      // eslint-disable-next-line no-console
      console.error(`Mailgun inbound webhook: AMBIGUOUS mailbox match for recipient ${recipient} — clients ${match.rows.map((m) => m.client_id).join(", ")}`);
      return NextResponse.json({ ok: true, matched_mailbox: false, ambiguous: true });
    }
    const receivingMailbox = match.row;

    // Same prospect can exist as several lead rows (different campaigns/months).
    // "Latest lead with this email" alone can pick the wrong campaign, so
    // prefer the candidate we actually emailed FROM THIS mailbox most
    // recently; only fall back to newest-lead when there is no such record.
    const { data: candidates } = await admin
      .from("leads")
      .select("id, client_id, campaign_id, name, tone_recovery_attempts, unsubscribed, booked, complained, email_bounced, manually_stopped")
      .eq("client_id", receivingMailbox.client_id)
      .eq("email", senderEmail)
      .order("created_at", { ascending: false })
      .limit(10);

    let lead = candidates?.[0];
    let matchedByThread = false;
    // Strongest signal first: the prospect's In-Reply-To points at a message
    // WE sent (provider_message_id, see supabase/add_email_threading.sql).
    // Tolerant of the column not existing yet (query error -> ignored).
    if (inReplyTo) {
      const bare = inReplyTo.replace(/^<|>$/g, "");
      const { data: threadMatch, error: threadError } = await admin
        .from("outreach_log")
        .select("lead_id")
        .eq("client_id", receivingMailbox.client_id)
        .in("provider_message_id", [inReplyTo, bare, `<${bare}>`])
        .limit(1)
        .maybeSingle<{ lead_id: string }>();
      if (!threadError && threadMatch) {
        const viaThread = candidates?.find((c) => c.id === threadMatch.lead_id);
        if (viaThread) {
          lead = viaThread;
          matchedByThread = true;
        }
      }
    }
    if (!matchedByThread && candidates && candidates.length > 1) {
      const { data: lastSend } = await admin
        .from("outreach_log")
        .select("lead_id")
        .eq("client_id", receivingMailbox.client_id)
        .eq("mailbox_id", receivingMailbox.id)
        .in("lead_id", candidates.map((c) => c.id))
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ lead_id: string }>();
      if (lastSend) lead = candidates.find((c) => c.id === lastSend.lead_id) ?? lead;
    }

    if (!lead) {
      return NextResponse.json({ ok: true, matched_lead: false });
    }

    const storeInbound = async (mailboxId: string, cls: string | null) => {
      const { error } = await admin.from("inbound_messages").insert({
        client_id: lead.client_id,
        lead_id: lead.id,
        mailbox_id: mailboxId,
        campaign_id: lead.campaign_id,
        provider_message_id: messageId,
        in_reply_to: inReplyTo || null,
        subject: inboundSubject || null,
        body: bodyPlain.slice(0, 8000),
        classification: cls,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`inbound_messages store skipped: ${error.message}`);
      }
    };

    // Already unsubscribed or already booked (e.g. they reply again after
    // opting out, or after already scheduling) — acknowledge and do nothing
    // further. Never re-engage, never send a second booking request.
    // Machine-generated mail (out-of-office, bounce, list, no-reply) is recorded but NEVER answered:
    // answering it starts auto-responder loops. It also does not count as a genuine reply.
    if (isAutomatedMessage(sender, String(form.get("message-headers") ?? ""))) {
      await storeInbound(receivingMailbox.id, null);
      return NextResponse.json({ ok: true, automated: true });
    }

    // A lead that is stopped for ANY reason (unsubscribed, booked, complained, bounced, manually
    // stopped) must not receive another automated message: record the inbound, send nothing.
    if (lead.unsubscribed || lead.booked || lead.complained || lead.email_bounced || lead.manually_stopped) {
      await storeInbound(receivingMailbox.id, null);
      return NextResponse.json({
        ok: true,
        already_unsubscribed: lead.unsubscribed,
        already_booked: lead.booked,
        stopped: Boolean(lead.complained || lead.email_bounced || lead.manually_stopped),
      });
    }

    const { data: client } = await admin
      .from("clients")
      .select("id, calendly_url, company_name")
      .eq("id", lead.client_id)
      .maybeSingle();

    // Reply from the exact mailbox that received this message, not an
    // arbitrary one of the client's mailboxes — otherwise the thread breaks
    // (different From address than what the lead replied to) and, if a
    // client's other mailbox happens to be on an unverified domain, the
    // auto-reply send could fail for a reason unrelated to this thread.
    const mailbox = receivingMailbox;

    // REGRESSION FIX (Final Regression Audit, 2026-10-09): this webhook's two
    // outbound sends (unsubscribe confirmation, AI auto-reply) were missed by
    // the original P0 fix's sweep. Computed once, used to gate both below —
    // inbound processing (lead state, dedup, logging) still happens either
    // way; only the OUTBOUND send is blocked, so a disconnected/unverified
    // domain never stops us from correctly recording that a reply arrived.
    const mailboxDomain = mailgunDomainForAddress(mailbox.address);
    const externalDomainsForReply = await getExternalDomainsForClient(admin, mailbox.client_id);
    const domainUsableForSending =
      (await assertDomainUsableByClient(admin, mailbox.client_id, mailboxDomain, { requireExplicitOwnership: externalDomainsForReply.has(mailboxDomain) })).usable &&
      !(await isDomainDisconnected(admin, mailbox.client_id, mailboxDomain));

    // Classify first, always — a stop/unsubscribe request used to short-circuit
    // before this and leave reply_classification NULL. The deterministic
    // unsubscribe check below still decides the stop action; the model only
    // labels the reply.
    const history = await buildEmailHistory(admin, lead.client_id, lead.id, mailbox.id);
    const { classification, confidence, reason } = await classifyReply(bodyPlain, history || undefined);

    if (isUnsubscribeRequest(bodyStripped)) {
      await admin
        .from("leads")
        .update({
          reply_received: true,
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
          next_follow_up_at: null,
          status: "dropped",
          reply_classification: classification,
          reply_confidence: confidence,
          reply_reason: reason,
        })
        .eq("id", lead.id);
      await storeInbound(mailbox.id, classification);

      await incrementCampaignReplyCount(admin, lead.campaign_id);

      if (mailbox && client && domainUsableForSending) {
        const confirmation = unsubscribeConfirmation(client.company_name ?? "us");
        try {
          const sentMsg = await sendMail({
            inReplyTo: messageId,
            domain: mailgunDomainForAddress(mailbox.address),
            from: mailbox.address,
            to: senderEmail,
            subject: confirmation.subject,
            text: confirmation.body,
          });
          await insertOutreachLog(admin, {
            provider_message_id: sentMsg.id,
            client_id: lead.client_id,
            campaign_id: lead.campaign_id,
            lead_id: lead.id,
            mailbox_id: mailbox.id,
            subject: confirmation.subject,
            body: confirmation.body,
            touch_number: REPLY_TOUCH_NUMBER,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`Unsubscribe confirmation send failed for lead ${lead.id}:`, (err as Error).message);
        }
      }

      return NextResponse.json({ ok: true, unsubscribed: true });
    }

    // Only Calendly configured for THIS client, never a fallback/placeholder
    // (spec §20, §28) — if it's missing, the drafted reply below just omits
    // the link (draftReplyEmail already handles calendlyUrl: null safely).
    const calendlyUrl = client?.calendly_url ?? null;

    // The dynamic meeting topic is resolved HERE — the moment a reply is
    // classified BOOKING — not at signup or Calendly-connect time, and
    // carried on the lead row so the eventual Calendly booking (recorded
    // independently, possibly minutes or days later) inherits exactly what
    // this conversation was about. Grounded in the actual reply text; falls
    // back to a generic event name rather than guessing a specific topic.
    const meetingTopic =
      classification === "BOOKING"
        ? await generateMeetingTopic({
            theirReply: bodyPlain,
            ourLastMessage: history || undefined,
            businessContext: formatBusinessContext(await getClientBusinessContext(admin, lead.client_id)),
          }).catch(() => null)
        : null;

    const { error: leadUpdateError } = await admin
      .from("leads")
      .update({
        reply_received: true,
        sentiment: SENTIMENT_COLUMN_VALUE[classification],
        status: STATUS_FOR_CLASSIFICATION[classification],
        reply_classification: classification,
        reply_confidence: confidence,
        reply_reason: reason,
        // A reply of any classification stops the automated follow-up
        // sequence (spec §19, §33) — BOOKING/HAPPY/ANGRY/UNCLEAR all clear
        // it; UNCLEAR must NOT restart it either (§18).
        next_follow_up_at: null,
        ...(meetingTopic ? { meeting_topic: meetingTopic } : {}),
        ...(classification === "ANGRY"
          ? { tone_recovery_attempts: (lead.tone_recovery_attempts ?? 0) + 1 }
          : {}),
      })
      .eq("id", lead.id);

    // A silent DB write failure here (e.g. a check-constraint violation) is
    // exactly the kind of bug that's invisible until someone notices a lead
    // never updated — surface it loudly instead.
    if (leadUpdateError) {
      // eslint-disable-next-line no-console
      console.error(`Failed to update lead ${lead.id} after reply:`, leadUpdateError.message);
    } else {
      await incrementCampaignReplyCount(admin, lead.campaign_id);
    }

    await storeInbound(mailbox.id, classification);

    // Owner-approved cap: after MAX_AUTO_REPLIES_PER_LEAD automatic replies to the same lead, a human takes over.
    const { count: priorAutoReplies } = await admin
      .from("outreach_log")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead.id)
      .eq("touch_number", REPLY_TOUCH_NUMBER);
    const autoReplyCapReached = (priorAutoReplies ?? 0) >= MAX_AUTO_REPLIES_PER_LEAD;
    if (autoReplyCapReached) {
      logEvent("inbound.auto_reply_cap", { client_id: lead.client_id, lead_id: lead.id, result: "human_takeover", cap: MAX_AUTO_REPLIES_PER_LEAD });
    }

    if (mailbox && client && !domainUsableForSending) {
      // eslint-disable-next-line no-console
      console.error(`Reply not sent: mailbox ${mailbox.address}'s domain ownership is unverified or disconnected`);
    } else if (mailbox && client && (await getMailboxReadiness(mailbox.address)) !== "ready") {
      // eslint-disable-next-line no-console
      console.error(`Reply not sent: mailbox ${mailbox.address} has no verified Mailgun domain`);
    } else if (mailbox && client && classification === "ANGRY" && (lead.tone_recovery_attempts ?? 0) > 0) {
      // The one-time re-engagement message to an annoyed lead was already sent; a second angry reply gets a human, not another pitch.
      logEvent("inbound.angry_repeat", { client_id: lead.client_id, lead_id: lead.id, result: "human_takeover" });
    } else if (mailbox && client && !autoReplyCapReached) {
      try {
        const draft = await draftReplyEmail({
          businessContext: formatBusinessContext(await getClientBusinessContext(admin, lead.client_id)),
          ourLastMessage: history || undefined,
          sentiment: classification,
          senderCompany: client.company_name ?? "us",
          leadName: lead.name || "there",
          theirReply: bodyPlain,
          calendlyUrl,
        });

        // Keep the prospect's own subject line ("Re: <what they replied to>") so mail clients keep this in the same
        // thread; the model's invented subject would split the conversation.
        const replySubject = /^\s*re:/i.test(inboundSubject) ? inboundSubject.trim() : `Re: ${inboundSubject.trim() || draft.subject}`;

        const sentReply = await sendMail({
          inReplyTo: messageId,
          domain: mailgunDomainForAddress(mailbox.address),
          from: mailbox.address,
          to: senderEmail,
          subject: replySubject,
          text: draft.body,
        });

        // Powers the per-lead sent-email history UI on the Leads page —
        // without this row the client can see the reply happened but never
        // what was actually sent back.
        await insertOutreachLog(admin, {
          provider_message_id: sentReply.id,
          client_id: lead.client_id,
          campaign_id: lead.campaign_id,
          lead_id: lead.id,
          mailbox_id: mailbox.id,
          subject: replySubject,
          body: draft.body,
          touch_number: REPLY_TOUCH_NUMBER,
        });
      } catch (err) {
        // Non-fatal — the reply is still recorded even if the auto-reply
        // drafting/send fails (e.g. Gemini hiccup, Mailgun error).
        // eslint-disable-next-line no-console
        console.error(`Auto-reply failed for lead ${lead.id}:`, (err as Error).message);
      }
    }

    return NextResponse.json({ ok: true, classification, confidence });
  } catch (err) {
    // The dedup row is already committed — never let an unexpected error
    // here cause Mailgun to retry-deliver into a guaranteed no-op.
    // eslint-disable-next-line no-console
    console.error("Mailgun inbound webhook failed after dedup:", (err as Error).message);
    return NextResponse.json({ ok: true, error: (err as Error).message });
  }
}
