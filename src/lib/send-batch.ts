import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { FORM_LEAD_SOURCE, autoSendSince } from "@/lib/campaign";
import { draftOfferPhrases } from "@/lib/gemini";
import { buildTemplateEmail } from "@/lib/outreach-template";
import { cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";
import { sendMail, mailgunDomainForAddress, getMailboxReadiness } from "@/lib/mailgun";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";

const DAILY_INITIAL_SEND_LIMIT = 4;
// First follow-up check happens 1 hour after the initial send (spec §17) —
// distinct from the older manual "Find leads" flow's 3-day interval, which
// is a separate feature this route doesn't touch.
const FIRST_FOLLOW_UP_DELAY_MS = 60 * 60 * 1000;
// Spread sends out instead of firing all four back-to-back (spec §12).
// Configurable — defaults keep a manual/test run's total wall-clock time
// reasonable; a real production cron can widen this via env vars.
const MIN_SEND_DELAY_MS = Number(process.env.DAILY_SEND_MIN_DELAY_MS ?? 15_000);
const MAX_SEND_DELAY_MS = Number(process.env.DAILY_SEND_MAX_DELAY_MS ?? 60_000);

function randomDelayMs() {
  return MIN_SEND_DELAY_MS + Math.floor(Math.random() * (MAX_SEND_DELAY_MS - MIN_SEND_DELAY_MS + 1));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fisher-Yates — mailbox order must be genuinely randomized per run, not a fixed hardcoded mapping (spec §11). */
function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

interface EligibleLead {
  id: string;
  name: string | null;
  company: string | null;
  job_title: string | null;
  email: string;
}

interface Mailbox {
  id: string;
  address: string;
}

/**
 * Sends today's batch of initial outreach emails for one client's active
 * monthly campaign — up to DAILY_INITIAL_SEND_LIMIT, one per eligible lead,
 * rotated across the client's own mailboxes only, with a randomized delay
 * between sends. Never touches another client's mailbox or leads (every
 * query below is scoped to `clientId`, resolved server-side).
 */
export async function sendBatchForClient(clientId: string) {
  const admin = createAdminClient();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const campaignMonth = (() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  })();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, status, sent_count")
    .eq("client_id", clientId)
    .eq("campaign_month", campaignMonth)
    .maybeSingle<{ id: string; status: string; sent_count: number }>();

  if (!campaign || campaign.status !== "active") {
    return { clientId, result: "skipped", detail: "no active campaign this month" };
  }

  // Idempotent daily cap: counts sends already recorded today, so running
  // this route twice in one day (retry, overlapping cron) never sends more
  // than DAILY_INITIAL_SEND_LIMIT total — the cap is enforced against actual
  // outreach_log rows, not an in-memory counter that resets per invocation.
  const { count: sentToday } = await admin
    .from("outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("touch_number", 1)
    .gte("sent_at", startOfToday.toISOString());

  const remaining = DAILY_INITIAL_SEND_LIMIT - (sentToday ?? 0);
  if (remaining <= 0) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "daily limit already reached" };
  }

  // Only leads the client requested through the lead-gen form (and, when set, created after automation was
  // switched on) are auto-sent; leads saved by default elsewhere are never touched by the scheduler.
  const since = autoSendSince();
  let eligibleQuery = admin
    .from("leads")
    .select("id, name, company, job_title, email")
    .eq("campaign_id", campaign.id)
    .eq("lead_source", FORM_LEAD_SOURCE)
    .eq("status", "new")
    .eq("unsubscribed", false)
    .eq("email_bounced", false)
    .eq("booked", false)
    .eq("complained", false)
    .eq("manually_stopped", false)
    .not("email", "is", null)
    .order("created_at", { ascending: true })
    .limit(remaining);
  if (since) eligibleQuery = eligibleQuery.gte("created_at", since);
  const { data: eligibleLeads } = await eligibleQuery.returns<EligibleLead[]>();

  if (!eligibleLeads || eligibleLeads.length === 0) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "no eligible leads" };
  }

  const { data: allMailboxes } = await admin
    .from("mailboxes")
    .select("id, address")
    .eq("client_id", clientId)
    .returns<Mailbox[]>();
  // Only mailboxes whose Mailgun domain is actually verified may send.
  const mailboxes: Mailbox[] = [];
  for (const m of allMailboxes ?? []) if ((await getMailboxReadiness(m.address)) === "ready") mailboxes.push(m);

  if (!mailboxes || mailboxes.length === 0) {
    // Never fall back to another client's mailbox (spec §3, §27).
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "no verified mailbox for this client" };
  }

  const { data: job } = await admin
    .from("lead_gen_jobs")
    .select("criteria")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ criteria: Record<string, unknown> }>();

  const sellingDescription = (job?.criteria?.what_you_sell as string | undefined)?.trim();
  if (!sellingDescription) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "no saved outreach description (what_you_sell)" };
  }

  const { data: clientRow } = await admin.from("clients").select("*").eq("id", clientId).maybeSingle();

  // Randomized mailbox rotation, not a fixed lead-position -> mailbox map.
  const context = await getClientBusinessContext(admin, clientId);
  const businessContext = formatBusinessContext(context);

  // The two variable phrases of the fixed email template are worded once per batch, not per lead.
  const senderCompanyName = clientRow?.company_name ?? "us";
  const phrases = await draftOfferPhrases({ sellingDescription, senderCompany: senderCompanyName, businessContext });
  // Industry is only stated when the campaign targeted exactly one, so it is never guessed per lead.
  const targetIndustries = Array.isArray(job?.criteria?.target_industries) ? (job!.criteria.target_industries as string[]) : [];
  const industry = targetIndustries.length === 1 ? String(targetIndustries[0]) : null;
  const rotatedMailboxes = shuffle(mailboxes);
  const sent: { leadId: string; mailbox: string; result: "sent" | "failed"; error?: string }[] = [];

  for (let i = 0; i < eligibleLeads.length; i++) {
    const lead = eligibleLeads[i];
    // Mailbox choice + daily-limit enforcement live in reserveMailboxSlot (atomic); the random rotation
    // above is superseded by "first ready mailbox with capacity".
    const reservation = await reserveMailboxSlot(admin, clientId, lead.id, { touch_number: 1, campaign_id: campaign.id });
    if (!reservation.ok) {
      sent.push({ leadId: lead.id, mailbox: "-", result: "failed", error: reservation.reason === "at_capacity" ? "mailbox daily limit reached" : "no ready mailbox" });
      break;
    }
    const mailbox = reservation.mailbox;

    // At-most-once per lead: two overlapping runs (cron + manual, or a restarted worker) can both have read
    // this lead as "new". Whoever flips last_contact_at from NULL wins; the other releases its slot and skips.
    const { data: claimedLead } = await admin
      .from("leads")
      .update({ last_contact_at: new Date().toISOString() })
      .eq("id", lead.id)
      .eq("client_id", clientId)
      .eq("status", "new")
      .is("last_contact_at", null)
      .select("id");
    if (!claimedLead?.length) {
      await releaseReservation(admin, reservation.reservationId);
      continue;
    }

    try {
      // Directory leads are businesses, not people: their "name" is the company name, so greet generically.
      const isBusinessLead = !lead.job_title || (lead.name ?? "").trim().toLowerCase() === (lead.company ?? "").trim().toLowerCase();
      const senderCompany = clientRow?.company_name ?? "us";

      // Fixed template, lint-checked. A draft that cannot pass is NOT sent (it would hurt the mailbox's reputation);
      // the lead stays "new" for the next run.
      const draft = cleanOutreachEmail(
        buildTemplateEmail({
          firstName: isBusinessLead ? null : lead.name,
          leadCompany: lead.company || "your company",
          industry,
          offer: phrases.offer,
          benefit: phrases.benefit,
          senderCompany,
          website: context.website ?? null,
        })
      );
      const issues = lintOutreachEmail(draft);
      if (issues.length) throw new Error(`Draft failed deliverability checks: ${issues.join("; ")}`);

      const sentMsg = await sendMail({
        domain: mailgunDomainForAddress(mailbox.address),
        // A display name makes the sender look like a business, which improves inbox placement.
        from: `${senderCompany.replace(/["<>\r\n]/g, "").trim() || "Team"} <${mailbox.address}>`,
        to: lead.email,
        subject: draft.subject,
        text: withUnsubscribeFooter(draft.body, { company: clientRow?.company_name, postalAddress: clientRow?.postal_address }),
        headers: unsubscribeHeaders(mailbox.address),
      });

      await Promise.all([
        finalizeReservation(admin, reservation.reservationId, { messageId: sentMsg.id, subject: draft.subject, body: draft.body }),
        admin
          .from("leads")
          .update({
            status: "email_sent",
            follow_up_number: 1,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at: new Date(Date.now() + FIRST_FOLLOW_UP_DELAY_MS).toISOString(),
          })
          .eq("id", lead.id),
      ]);

      sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "sent" });
    } catch (err) {
      await releaseReservation(admin, reservation.reservationId);
      await admin.from("leads").update({ last_contact_at: null }).eq("id", lead.id).eq("status", "new");
      // One lead failing (bad address, Mailgun hiccup) doesn't stop the rest
      // of today's batch — it just stays "new" for tomorrow's run to retry.
      sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "failed", error: (err as Error).message });
    }

    if (i < eligibleLeads.length - 1) await sleep(randomDelayMs());
  }

  const successCount = sent.filter((s) => s.result === "sent").length;
  if (successCount > 0) {
    await admin
      .from("campaigns")
      .update({ sent_count: (campaign.sent_count ?? 0) + successCount })
      .eq("id", campaign.id);
  }

  return { clientId, campaignId: campaign.id, result: "processed", sent };
}

