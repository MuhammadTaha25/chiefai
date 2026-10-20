import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";
import { draftFollowUpEmail } from "@/lib/gemini";
import { applyGreetingAndSignoff, cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";
import { autoSendSince } from "@/lib/campaign";
import { resolveFollowUpIntervalMs, planFollowUp } from "@/lib/follow-up-config";
import { isSendWindowBroken, resolveSendWindow, withinSendWindow } from "@/lib/send-window";
import { followUpGapMs, stillWaiting } from "@/lib/send-jitter";
import { isValidTimeZone, localClock } from "@/lib/social-schedule";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";

// Cadence between stages comes from follow-up-config.ts (client-configurable
// via criteria.follow_up_delay_days, default 3 days) — shared with
// send-batch.ts so the two can never silently diverge. The atomic claim below
// still re-checks latest state immediately before each follow-up, regardless
// of how long the interval itself is.
// Hard system ceiling — never exceeded regardless of any client-configured
// follow-up count (maxFollowUpsFor below can only make this stricter).
const HARD_MAX_FOLLOW_UPS = 3;

// Back-off after a draft/send failure (transient Gemini/Mailgun error): the lead keeps its place in the sequence.
const SEND_FAILURE_RETRY_MS = 60 * 60 * 1000;
// Back-off for problems that need a human fix (missing config, unknown original mailbox): once a day.
const NEEDS_ATTENTION_RETRY_MS = 24 * 60 * 60 * 1000;

const FOLLOW_UP_COUNT_WORDS: Record<string, number> = {
  "no follow-up": 0,
  "1 follow-up": 1,
  "2 follow-ups": 2,
  "3 follow-ups": 3,
  "5 follow-ups": 5,
};

function maxFollowUpsFor(followUpsAnswer: string | undefined): number {
  if (!followUpsAnswer) return 3;
  const known = FOLLOW_UP_COUNT_WORDS[followUpsAnswer.toLowerCase()];
  if (known !== undefined) return known;
  const parsed = parseInt(followUpsAnswer, 10);
  return Number.isFinite(parsed) ? parsed : 3;
}

interface DueLead {
  id: string;
  client_id: string;
  campaign_id: string | null;
  name: string | null;
  company: string | null;
  email: string;
  follow_up_number: number | null;
  next_follow_up_at: string | null;
  industry: string | null;
}

// Max leads processed per client per cron run. ONE follow-up per client per run: the cron ticks every 5 minutes, so a
// client's follow-ups are spaced at least that far apart instead of leaving back-to-back within seconds (a burst to
// one domain is a spam signal), and one tenant's failing leads cannot starve others.
const MAX_LEADS_PER_CLIENT = 1;
// If anything from this client went out in the last few minutes (a first email or another follow-up), wait for the next run.
// Random 3-10 min wait (repeatable per previous send), not a fixed gap: see send-jitter.ts.

// Puts a claimed lead back in the queue after a problem. Guarded with `is null` so it can never overwrite a
// next_follow_up_at that something else has set in the meantime.
async function deferFollowUp(admin: ReturnType<typeof createAdminClient>, leadId: string, delayMs: number) {
  await admin
    .from("leads")
    .update({ next_follow_up_at: new Date(Date.now() + delayMs).toISOString() })
    .eq("id", leadId)
    .is("next_follow_up_at", null);
}

/**
 * One follow-up batch: picks up leads whose next_follow_up_at has passed, drafts a short follow-up, sends it
 * through the SAME mailbox that sent the lead's first email, and reschedules the next one (or stops at the client's
 * cap). Shared by the cron/manual route and by tests; `isCron` applies the automation-only lead rules.
 *
 * Multi-tenant fairness: in cron mode the batch is built per-client (round-robin style) so one
 * client's stale/failing leads cannot block other tenants from being processed.
 */
export async function runFollowUpBatch(opts: { clientIdFilter: string | null; isCron: boolean }) {
  const { clientIdFilter, isCron } = opts;
  const admin = createAdminClient();

  // Base filter shared by all queries in this function.
  function baseQuery() {
    let q = admin
      .from("leads")
      .select("id, client_id, campaign_id, name, company, email, follow_up_number, next_follow_up_at, industry")
      .gte("follow_up_number", 1) // only a lead whose initial email was actually sent can get a follow-up
      .eq("reply_received", false)
      .eq("unsubscribed", false)
      .eq("email_bounced", false)
      .eq("booked", false)
      .eq("complained", false)
      .eq("manually_stopped", false)
      .not("email", "is", null)
      .lte("next_follow_up_at", new Date().toISOString())
      // A lead whose last email soft-bounced (mailbox full, server busy) waits out its retry time first.
      .or(`bounce_retry_after.is.null,bounce_retry_after.lte.${new Date().toISOString()}`)
      .order("next_follow_up_at", { ascending: true });

    // Follow-ups apply to any lead that received an initial email — both AI-prospected leads and
    // manually-added leads. The lead_source filter is intentionally NOT applied here: if a client
    // added a lead manually and the initial email was sent (follow_up_number >= 1), the follow-up
    // sequence should continue automatically.
    // AUTO_SEND_LEADS_SINCE still applies to prevent the cron from reaching back to very old leads
    // that were created before automation was switched on.
    if (isCron) {
      const since = autoSendSince();
      if (since) q = q.gte("created_at", since);
    }

    return q;
  }

  let dueLeads: DueLead[];

  if (clientIdFilter) {
    // Manual/session-auth run: single client, up to 25 leads, no fairness concern.
    const { data, error } = await baseQuery()
      .eq("client_id", clientIdFilter)
      .limit(25)
      .returns<DueLead[]>();
    if (error) return { ok: false as const, error: error.message, results: [] as FollowUpResult[] };
    dueLeads = data ?? [];
  } else {
    // Cron run: round-robin across clients so one tenant's failing leads cannot
    // starve others. Fetch up to MAX_LEADS_PER_CLIENT per client in parallel.
    const { data: clientRows, error: clientErr } = await admin
      .from("leads")
      .select("client_id")
      .gte("follow_up_number", 1)
      .eq("reply_received", false)
      .eq("unsubscribed", false)
      .eq("email_bounced", false)
      .eq("booked", false)
      .eq("complained", false)
      .eq("manually_stopped", false)
      .not("email", "is", null)
      .lte("next_follow_up_at", new Date().toISOString())
      .or(`bounce_retry_after.is.null,bounce_retry_after.lte.${new Date().toISOString()}`);

    if (clientErr) return { ok: false as const, error: clientErr.message, results: [] as FollowUpResult[] };

    const clientIds = [...new Set((clientRows ?? []).map((r: { client_id: string }) => r.client_id))];

    const perClientResults = await Promise.all(
      clientIds.map((cid) =>
        baseQuery()
          .eq("client_id", cid)
          .limit(MAX_LEADS_PER_CLIENT)
          .returns<DueLead[]>()
          .then(({ data }) => data ?? [])
      )
    );
    dueLeads = perClientResults.flat();
  }

  const results: FollowUpResult[] = [];
  if (isCron) await recoverOrphanedFollowUps(admin);
  // Soft time budget so one run stays inside a short serverless limit; anything
  // not reached keeps its next_follow_up_at and is picked up by the next run.
  const runStartedAt = Date.now();
  // P0 defensive re-check (see send-batch.ts): cached per client_id since one
  // batch spans every client's due leads, not just one.
  const externalDomainsByClient = new Map<string, Set<string>>();
  async function externalDomainsFor(clientId: string): Promise<Set<string>> {
    const cached = externalDomainsByClient.get(clientId);
    if (cached) return cached;
    const fresh = await getExternalDomainsForClient(admin, clientId);
    externalDomainsByClient.set(clientId, fresh);
    return fresh;
  }
  // Follow-ups only go out inside the client's own daytime send window (same window and timezone as first emails),
  // so nobody gets a follow-up at 3am. Outside it the lead is left untouched and the next 5-minute run retries.
  // A client with no valid timezone has no window we can trust, so it is not blocked.
  const windowOpenByKey = new Map<string, boolean>();
  async function windowOpen(clientId: string, campaignId: string | null): Promise<boolean> {
    const key = `${clientId}|${campaignId ?? ""}`;
    const cached = windowOpenByKey.get(key);
    if (cached !== undefined) return cached;
    const [{ data: c }, { data: camp }] = await Promise.all([
      admin.from("clients").select("timezone, outreach_send_start, outreach_send_end").eq("id", clientId).maybeSingle<{ timezone: string | null; outreach_send_start: string | null; outreach_send_end: string | null }>(),
      campaignId
        ? admin.from("campaigns").select("timezone, send_window_start, send_window_end").eq("id", campaignId).maybeSingle<{ timezone: string | null; send_window_start: string | null; send_window_end: string | null }>()
        : Promise.resolve({ data: null }),
    ]);
    const tz = camp?.timezone ?? c?.timezone;
    let open = true;
    if (isValidTimeZone(tz)) {
      const ws = camp?.send_window_start ?? c?.outreach_send_start;
      const we = camp?.send_window_end ?? c?.outreach_send_end;
      // A configured but unusable window keeps follow-ups closed too (never widens to the default).
      open = isSendWindowBroken(ws, we) ? false : withinSendWindow(resolveSendWindow(ws, we), localClock(tz).minutes);
    }
    windowOpenByKey.set(key, open);
    return open;
  }

  for (const lead of dueLeads ?? []) {
    if (Date.now() - runStartedAt > 45_000) break;
    try {
      if (!(await windowOpen(lead.client_id, lead.campaign_id))) {
        results.push({ leadId: lead.id, result: "skipped", detail: "outside the client's send window - waiting for the window to open" });
        continue;
      }
      // Pacing: space a client's sends. Left untouched (still due) so the next run retries.
      const { data: lastSend } = await admin
        .from("outreach_log")
        .select("sent_at")
        .eq("client_id", lead.client_id)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ sent_at: string }>();
      if (lastSend && stillWaiting(lastSend.sent_at, followUpGapMs(lastSend.sent_at))) {
        results.push({ leadId: lead.id, result: "skipped", detail: "pacing: waiting a few minutes after this client's last send" });
        continue;
      }
      // Atomic claim: only proceed if next_follow_up_at is still exactly
      // what we just read it AND every stop condition (spec §18 priority
      // list) is still false at this exact instant — not just what the
      // SELECT above saw a moment ago. A reply, bounce, unsubscribe, or
      // booking that landed in the gap between that SELECT and this UPDATE
      // (or a concurrent/overlapping cron run that already claimed this
      // lead) makes this conditional update match 0 rows, and we skip —
      // the only way to guarantee "check latest state immediately before
      // every follow-up" rather than trusting a few-hundred-ms-stale read.
      const { data: claimed } = await admin
        .from("leads")
        .update({ next_follow_up_at: null })
        .eq("id", lead.id)
        .eq("next_follow_up_at", lead.next_follow_up_at)
        .gte("follow_up_number", 1)
        .eq("reply_received", false)
        .eq("unsubscribed", false)
        .eq("email_bounced", false)
        .eq("booked", false)
        .eq("complained", false)
        .eq("manually_stopped", false)
        .select("id");

      if (!claimed || claimed.length === 0) {
        results.push({ leadId: lead.id, result: "skipped", detail: "already claimed by a concurrent run" });
        continue;
      }

      const [{ data: client }, { data: job }] = await Promise.all([
        admin.from("clients").select("*").eq("id", lead.client_id).maybeSingle(),
        admin
          .from("lead_gen_jobs")
          .select("criteria")
          .eq("client_id", lead.client_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ criteria: Record<string, unknown> }>(),
      ]);

      const sellingDescription = (job?.criteria?.what_you_sell as string | undefined)?.trim();
      // A client can configure fewer follow-ups, never more than the spec's
      // hard system ceiling of 3 (§17).
      const maxFollowUps = Math.min(maxFollowUpsFor(job?.criteria?.follow_ups as string | undefined), HARD_MAX_FOLLOW_UPS);

      // follow_up_number counts the INITIAL email as 1, so the cap, touch number, status and email angle all come
      // from one helper (see planFollowUp) — otherwise "3 follow-ups" sends only 2 and touch numbers skip a value.
      const { nextFollowUpNumber, followUpIndex, capped, isLast, status } = planFollowUp(lead.follow_up_number, maxFollowUps);

      if (!sellingDescription) {
        // Nothing to draft from. This is a config problem, not a cap — keep the lead in the sequence and retry
        // daily so it resumes by itself once the client saves their outreach description.
        await deferFollowUp(admin, lead.id, NEEDS_ATTENTION_RETRY_MS);
        results.push({ leadId: lead.id, result: "skipped", detail: "no saved outreach description (what_you_sell) — will retry in 24h" });
        continue;
      }

      if (capped) {
        // Cap reached — stop scheduling further follow-ups.
        await admin.from("leads").update({ next_follow_up_at: null }).eq("id", lead.id);
        results.push({ leadId: lead.id, result: "capped" });
        continue;
      }

      // A follow-up must come from the SAME mailbox as the lead's first email (thread continuity, and a sender that
      // suddenly changes mid-thread looks suspicious). The mailbox is read from the lead's earliest logged send and
      // pinned below; if it is unavailable the follow-up WAITS — it never switches to another mailbox.
      const { data: firstSend } = await admin
        .from("outreach_log")
        .select("mailbox_id")
        .eq("client_id", lead.client_id)
        .eq("lead_id", lead.id)
        .not("mailbox_id", "is", null)
        .order("sent_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ mailbox_id: string }>();
      if (!firstSend?.mailbox_id) {
        await deferFollowUp(admin, lead.id, NEEDS_ATTENTION_RETRY_MS);
        results.push({ leadId: lead.id, result: "skipped", detail: "no earlier send recorded for this lead, so the original mailbox is unknown — follow-up held, will retry in 24h" });
        continue;
      }

      // Reserve a slot on that mailbox (daily limit, atomic) BEFORE drafting/sending. No capacity or an unready
      // mailbox is temporary: put the follow-up back exactly as it was so a later run retries it.
      // touch_number: the initial email is touch 1, so the first follow-up is touch 2 (= nextFollowUpNumber).
      const reservation = await reserveMailboxSlot(
        admin,
        lead.client_id,
        lead.id,
        { touch_number: nextFollowUpNumber, campaign_id: lead.campaign_id },
        { mailboxId: firstSend.mailbox_id },
      );
      if (!reservation.ok && reservation.reason === "duplicate_touch") {
        // This follow-up was already sent (or is being sent): never send it twice. Check again in a day.
        await deferFollowUp(admin, lead.id, NEEDS_ATTENTION_RETRY_MS);
        results.push({ leadId: lead.id, result: "skipped", detail: "this follow-up already exists for the lead - not sending a duplicate" });
        continue;
      }
      if (!reservation.ok) {
        await admin.from("leads").update({ next_follow_up_at: lead.next_follow_up_at }).eq("id", lead.id).is("next_follow_up_at", null);
        results.push({
          leadId: lead.id,
          result: "skipped",
          detail:
            reservation.reason === "at_capacity"
              ? "original mailbox daily limit reached — waiting (follow-ups never switch mailbox)"
              : reservation.reason === "all_unhealthy"
                ? "original mailbox paused: high bounce/complaint rate — waiting (follow-ups never switch mailbox)"
                : "original mailbox not ready — waiting (follow-ups never switch mailbox)",
        });
        continue;
      }
      const mailbox = reservation.mailbox;

      const mailboxDomain = mailgunDomainForAddress(mailbox.address);
      const externalDomains = await externalDomainsFor(lead.client_id);
      const usable = await assertDomainUsableByClient(admin, lead.client_id, mailboxDomain, { requireExplicitOwnership: externalDomains.has(mailboxDomain) });
      if (!usable.usable || (await isDomainDisconnected(admin, lead.client_id, mailboxDomain))) {
        await releaseReservation(admin, reservation.reservationId);
        // Back off 24 hours instead of restoring the original timestamp — this prevents stale domain
        // failures from re-entering the queue every hour and starving other leads. Once per day is
        // frequent enough to pick up automatically when the domain issue is resolved.
        await deferFollowUp(admin, lead.id, NEEDS_ATTENTION_RETRY_MS);
        results.push({ leadId: lead.id, result: "error", detail: `Domain ${mailboxDomain} is not usable (ownership unverified or disconnected) — follow-up blocked, will retry in 24h` });
        continue;
      }

      // Set once Mailgun has accepted the email. After that point the follow-up IS sent, so a later database
      // error must never release the slot or put the lead back in the queue (that would send it twice).
      let mailSent = false;
      try {
      const businessContext = formatBusinessContext(await getClientBusinessContext(admin, lead.client_id));
      // Thread the follow-up onto the last message we really sent this lead (provider
      // message id from add_email_threading.sql). Missing/undefined is fine.
      // The "pending:" rows are mailbox-slot reservations (this run's own included, inserted a moment ago with
      // sent_at = now()); they are not real Message-Ids and would put a bogus In-Reply-To/References on the email.
      const { data: priorSends } = await admin
        .from("outreach_log")
        .select("provider_message_id, subject, body")
        .eq("client_id", lead.client_id)
        .eq("lead_id", lead.id)
        .not("provider_message_id", "is", null)
        .not("provider_message_id", "like", "pending:%")
        .order("sent_at", { ascending: true })
        .limit(10)
        .returns<{ provider_message_id: string; subject: string | null; body: string | null }[]>();
      const prevSend = priorSends && priorSends.length ? priorSends[priorSends.length - 1] : null;
      const draftParams = {
        businessContext,
        sellingDescription,
        senderCompany: client?.company_name ?? "us",
        // Directory leads are businesses: their "name" is the company name, so greet generically.
        leadName: (lead.name ?? "").trim().toLowerCase() === (lead.company ?? "").trim().toLowerCase() ? "there" : lead.name || "there",
        leadCompany: lead.company || "your company",
        leadIndustry: lead.industry,
        // The drafter's angle table (gemini.ts FOLLOW_UP_ANGLES) is 1-based over follow-ups: 1 = first follow-up.
        followUpNumber: followUpIndex,
        isLastFollowUp: isLast,
        previousEmails: (priorSends ?? []).filter((p) => p.body).map((p) => ({ subject: p.subject ?? "", body: p.body ?? "" })),
      };
      // Never send a follow-up that trips the spam checks (e.g. "free"): redraft a few times, then defer the lead.
      const earlierBodies = (priorSends ?? []).map((p) => p.body ?? "").filter(Boolean);
      const frameDraft = (d: { subject: string; body: string }) =>
        applyGreetingAndSignoff(d, { greetingName: draftParams.leadName === "there" ? null : draftParams.leadName, senderName: draftParams.senderCompany });
      let draft = frameDraft(cleanOutreachEmail(await draftFollowUpEmail(draftParams)));
      let lintIssues = lintOutreachEmail(draft, { firstTouch: false, earlierBodies, industry: lead.industry });
      for (let attempt = 0; lintIssues.length && attempt < 2; attempt++) {
        draft = frameDraft(cleanOutreachEmail(await draftFollowUpEmail(draftParams)));
        lintIssues = lintOutreachEmail(draft, { firstTouch: false, earlierBodies, industry: lead.industry });
      }
      if (lintIssues.length) throw new Error(`Follow-up draft failed spam checks: ${lintIssues.join("; ")}`);
      // Same subject as the first email (no "Re:") so Gmail and other clients group every touch into ONE thread
      // through the In-Reply-To header, without the fake-reply prefix that cold-email filters penalise.
      const threadSubject = (priorSends ?? []).map((p) => (p.subject ?? "").trim()).find((s) => s && s !== "(sending)");
      if (threadSubject) draft.subject = threadSubject;

      const sentMsg = await sendMail({
        inReplyTo: prevSend?.provider_message_id,
        domain: mailgunDomainForAddress(mailbox.address),
        from: `${(client?.company_name ?? "").replace(/["<>\r\n]/g, "").trim() || "Team"} <${mailbox.address}>`,
        to: lead.email,
        subject: draft.subject,
        text: withUnsubscribeFooter(draft.body, { company: client?.company_name, postalAddress: client?.postal_address }),
        headers: unsubscribeHeaders(mailbox.address),
      });
      mailSent = true;

      await Promise.all([
        finalizeReservation(admin, reservation.reservationId, { messageId: sentMsg.id, subject: draft.subject, body: draft.body }),
        admin
          .from("leads")
          .update({
            status,
            follow_up_number: nextFollowUpNumber,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at:
              isLast
                ? null
                : new Date(Date.now() + resolveFollowUpIntervalMs(job?.criteria)).toISOString(),
          })
          .eq("id", lead.id),
      ]);

      results.push({ leadId: lead.id, result: "sent" });
      } catch (sendErr) {
        if (mailSent) {
          // The email already went out; do not release the slot or requeue the lead (no double send).
          // Surface it loudly so the lead's row can be checked by hand.
          results.push({ leadId: lead.id, result: "error", detail: `email SENT but recording it failed — check this lead manually: ${(sendErr as Error).message}` });
          continue;
        }
        await releaseReservation(admin, reservation.reservationId);
        // Draft/send failed before anything went out: keep the lead in the sequence and retry in an hour,
        // instead of leaving next_follow_up_at null (which would silently end its sequence).
        await deferFollowUp(admin, lead.id, SEND_FAILURE_RETRY_MS);
        throw sendErr;
      }
    } catch (err) {
      results.push({ leadId: lead.id, result: "error", detail: (err as Error).message });
    }
  }

  return { ok: true as const, results };
}

export type FollowUpResult = { leadId: string; result: "sent" | "capped" | "skipped" | "error"; detail?: string };


/**
 * A follow-up claims its lead by clearing next_follow_up_at. If the run dies (timeout, crash) between that claim and the
 * reschedule, the lead is left with no schedule and would never be followed up. This puts such leads back in the queue.
 * Deliberately conservative: only leads contacted in the last 3 days, never one touched in the last 30 minutes (a run may
 * still be working on it), and only when the client's follow-up allowance is not used up. The unique (lead, touch) index
 * is the final guard against a duplicate.
 */
export async function recoverOrphanedFollowUps(admin: ReturnType<typeof createAdminClient>) {
  const now = Date.now();
  const { data: candidates } = await admin
    .from("leads")
    .select("id, client_id, follow_up_number, last_contact_at")
    .gte("follow_up_number", 1)
    .lte("follow_up_number", 3)
    .is("next_follow_up_at", null)
    .eq("reply_received", false)
    .eq("unsubscribed", false)
    .eq("email_bounced", false)
    .eq("booked", false)
    .eq("complained", false)
    .eq("manually_stopped", false)
    .gte("last_contact_at", new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString())
    .lte("last_contact_at", new Date(now - 30 * 60 * 1000).toISOString())
    .limit(20)
    .returns<{ id: string; client_id: string; follow_up_number: number; last_contact_at: string }[]>();
  for (const l of candidates ?? []) {
    const { data: lastLog } = await admin
      .from("outreach_log")
      .select("sent_at")
      .eq("lead_id", l.id)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ sent_at: string }>();
    if (lastLog && now - Date.parse(lastLog.sent_at) < 30 * 60 * 1000) continue;
    const { data: job } = await admin
      .from("lead_gen_jobs")
      .select("criteria")
      .eq("client_id", l.client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ criteria: Record<string, unknown> }>();
    const max = Math.min(maxFollowUpsFor(job?.criteria?.follow_ups as string | undefined), HARD_MAX_FOLLOW_UPS);
    if (planFollowUp(l.follow_up_number, max).capped) continue;
    // Due when the normal interval after the last contact has passed.
    const due = Date.parse(l.last_contact_at) + resolveFollowUpIntervalMs(job?.criteria);
    await admin.from("leads").update({ next_follow_up_at: new Date(Math.max(due, now)).toISOString() }).eq("id", l.id).is("next_follow_up_at", null);
  }
}
