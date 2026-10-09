import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";
import { draftFollowUpEmail } from "@/lib/gemini";
import { cleanOutreachEmail } from "@/lib/email-quality";
import { FORM_LEAD_SOURCE, autoSendSince } from "@/lib/campaign";
import { resolveFollowUpIntervalMs } from "@/lib/follow-up-config";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";

// Cadence between stages comes from follow-up-config.ts (client-configurable
// via criteria.follow_up_delay_days, default 3 days) — shared with
// send-batch.ts so the two can never silently diverge. The atomic claim below
// still re-checks latest state immediately before each follow-up, regardless
// of how long the interval itself is.
// Hard system ceiling — never exceeded regardless of any client-configured
// follow-up count (maxFollowUpsFor below can only make this stricter).
const HARD_MAX_FOLLOW_UPS = 3;

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
}

/**
 * One follow-up batch: picks up leads whose next_follow_up_at has passed, drafts a short follow-up, sends it
 * through a ready mailbox with capacity, and reschedules the next one (or stops at the client's cap). Shared by
 * the cron/manual route and by tests; `isCron` applies the automation-only lead rules.
 */
export async function runFollowUpBatch(opts: { clientIdFilter: string | null; isCron: boolean }) {
  const { clientIdFilter, isCron } = opts;
  const admin = createAdminClient();

  let query = admin
    .from("leads")
    .select("id, client_id, campaign_id, name, company, email, follow_up_number, next_follow_up_at")
    .gte("follow_up_number", 1) // only a lead whose initial email was actually sent can get a follow-up
    .eq("reply_received", false)
    .eq("unsubscribed", false)
    .eq("email_bounced", false)
    .eq("booked", false)
    .eq("complained", false)
    .eq("manually_stopped", false)
    .not("email", "is", null)
    .lte("next_follow_up_at", new Date().toISOString())
    .order("next_follow_up_at", { ascending: true })
    .limit(25); // bound one run (each lead = Gemini + Mailgun); the remainder is picked up next hour

  if (clientIdFilter) query = query.eq("client_id", clientIdFilter);

  // The scheduler applies the same rule as automatic first emails: only leads that came from the lead-gen form
  // (and, when AUTO_SEND_LEADS_SINCE is set, were created after it) are followed up automatically, so turning
  // this cron on never reaches back to older leads. A client running follow-ups by hand for their own leads is unaffected.
  if (isCron) {
    query = query.eq("lead_source", FORM_LEAD_SOURCE);
    const since = autoSendSince();
    if (since) query = query.gte("created_at", since);
  }

  const { data: dueLeads, error: leadsError } = await query.returns<DueLead[]>();
  if (leadsError) {
    return { ok: false as const, error: leadsError.message, results: [] as FollowUpResult[] };
  }

  const results: FollowUpResult[] = [];
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
  for (const lead of dueLeads ?? []) {
    if (Date.now() - runStartedAt > 45_000) break;
    try {
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
      const nextFollowUpNumber = (lead.follow_up_number ?? 0) + 1;

      if (!sellingDescription || nextFollowUpNumber > maxFollowUps) {
        // Cap reached (or nothing to draft from) — stop scheduling further follow-ups.
        await admin.from("leads").update({ next_follow_up_at: null }).eq("id", lead.id);
        results.push({ leadId: lead.id, result: "capped" });
        continue;
      }

      // Reserve a mailbox slot (daily limit, atomic) BEFORE drafting/sending. No capacity or no ready
      // mailbox is temporary: put the follow-up back exactly as it was so a later run retries it.
      const reservation = await reserveMailboxSlot(admin, lead.client_id, lead.id, {
        touch_number: nextFollowUpNumber + 1,
        campaign_id: lead.campaign_id,
      });
      if (!reservation.ok) {
        await admin.from("leads").update({ next_follow_up_at: lead.next_follow_up_at }).eq("id", lead.id).is("next_follow_up_at", null);
        results.push({ leadId: lead.id, result: "skipped", detail: reservation.reason === "at_capacity" ? "mailbox daily limit reached" : "no ready mailbox" });
        continue;
      }
      const mailbox = reservation.mailbox;

      const mailboxDomain = mailgunDomainForAddress(mailbox.address);
      const externalDomains = await externalDomainsFor(lead.client_id);
      const usable = await assertDomainUsableByClient(admin, lead.client_id, mailboxDomain, { requireExplicitOwnership: externalDomains.has(mailboxDomain) });
      if (!usable.usable || (await isDomainDisconnected(admin, lead.client_id, mailboxDomain))) {
        await releaseReservation(admin, reservation.reservationId);
        await admin.from("leads").update({ next_follow_up_at: lead.next_follow_up_at }).eq("id", lead.id).is("next_follow_up_at", null);
        results.push({ leadId: lead.id, result: "error", detail: `Domain ${mailboxDomain} is not usable (ownership unverified or disconnected) — follow-up blocked` });
        continue;
      }

      try {
      const businessContext = formatBusinessContext(await getClientBusinessContext(admin, lead.client_id));
      // Thread the follow-up onto the last message we sent this lead (provider
      // message id from add_email_threading.sql). Missing/undefined is fine.
      const { data: prevSend } = await admin
        .from("outreach_log")
        .select("provider_message_id")
        .eq("client_id", lead.client_id)
        .eq("lead_id", lead.id)
        .not("provider_message_id", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ provider_message_id: string }>();
      const draft = cleanOutreachEmail(await draftFollowUpEmail({
        businessContext,
        sellingDescription,
        senderCompany: client?.company_name ?? "us",
        // Directory leads are businesses: their "name" is the company name, so greet generically.
        leadName: (lead.name ?? "").trim().toLowerCase() === (lead.company ?? "").trim().toLowerCase() ? "there" : lead.name || "there",
        leadCompany: lead.company || "your company",
        followUpNumber: nextFollowUpNumber,
      }));

      const sentMsg = await sendMail({
        inReplyTo: prevSend?.provider_message_id,
        domain: mailgunDomainForAddress(mailbox.address),
        from: `${(client?.company_name ?? "").replace(/["<>\r\n]/g, "").trim() || "Team"} <${mailbox.address}>`,
        to: lead.email,
        subject: draft.subject,
        text: withUnsubscribeFooter(draft.body, { company: client?.company_name, postalAddress: client?.postal_address }),
        headers: unsubscribeHeaders(mailbox.address),
      });

      await Promise.all([
        finalizeReservation(admin, reservation.reservationId, { messageId: sentMsg.id, subject: draft.subject, body: draft.body }),
        admin
          .from("leads")
          .update({
            status: `follow_up_${Math.min(nextFollowUpNumber, 10)}`,
            follow_up_number: nextFollowUpNumber,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at:
              nextFollowUpNumber >= maxFollowUps
                ? null
                : new Date(Date.now() + resolveFollowUpIntervalMs(job?.criteria)).toISOString(),
          })
          .eq("id", lead.id),
      ]);

      results.push({ leadId: lead.id, result: "sent" });
      } catch (sendErr) {
        await releaseReservation(admin, reservation.reservationId);
        throw sendErr;
      }
    } catch (err) {
      results.push({ leadId: lead.id, result: "error", detail: (err as Error).message });
    }
  }

  return { ok: true as const, results };
}

export type FollowUpResult = { leadId: string; result: "sent" | "capped" | "skipped" | "error"; detail?: string };
