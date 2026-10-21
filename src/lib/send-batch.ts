import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { FORM_LEAD_SOURCE, autoSendSince } from "@/lib/campaign";
import { draftOfferPhrases, draftAidaEmail } from "@/lib/gemini";
import { fetchCompanyDescriptionViaMcp } from "@/lib/vibe-prospecting-mcp";
// Note: fetchCompanyDescriptionViaMcp uses the already-connected Vibe Prospecting OAuth session.
// No separate API key needed — falls back gracefully to null if not connected or any error.
import { bareDomain, buildTemplateEmail } from "@/lib/outreach-template";
import { renderCustomTemplate } from "@/lib/custom-template";
import { applyGreetingAndSignoff, cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";
import { sendMail, mailgunDomainForAddress, getMailboxReadiness } from "@/lib/mailgun";
import { checkEmailAddress } from "@/lib/email-address-check";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";
import { resolveFirstFollowUpDelayMs } from "@/lib/follow-up-config";
import { DEFAULT_SEND_WINDOW, activeBlockIndex, isSendWindowBroken, planBlocks, resolveSendWindow } from "@/lib/send-window";
import { plannedGapMs, stillWaiting } from "@/lib/send-jitter";
import { isValidTimeZone, localClock } from "@/lib/social-schedule";
import { resolveDailySendCap } from "@/lib/send-cap";
import { effectiveDailyLimit } from "@/lib/mailbox-readiness";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";
import { startOfLocalDay } from "@/lib/company-facts";

// Default daily cap lives in send-cap.ts (DEFAULT_DAILY_INITIAL_SEND_LIMIT = 4); a tenant can override it with clients.daily_send_cap.
// The delay before the first follow-up check comes from follow-up-config.ts
// (client-configurable via criteria.follow_up_delay_days, default 3 days) —
// shared with follow-ups.ts so the two can never silently diverge.
// Pacing: one send per run. Mailboxes run in blocks across the window (send-window.ts); inside a block, sends are spaced
// by the planned gap, enforced by checking the last send time. The cron cadence decides when the next run can go.

interface EligibleLead {
  id: string;
  name: string | null;
  company: string | null;
  job_title: string | null;
  email: string;
  city: string | null;
  country: string | null;
}

/**
 * Sends today's batch of initial outreach emails for one client's active
 * monthly campaign — up to the tenant daily cap, one per eligible lead,
 * sent in mailbox blocks across the client's window (see planBlocks), only from the client's own mailboxes. Never touches another client's mailbox or leads (every
 * query below is scoped to `clientId`, resolved server-side).
 */
export async function sendBatchForClient(clientId: string) {
  const admin = createAdminClient();

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

  // Sending window and timezone: campaign-level overrides take precedence over client-level defaults.
  // The default window 08:00-24:00 applies in the resolved timezone, never a server default. Without
  // a valid timezone nothing is sent. Mailboxes run in blocks: mailbox i (in creation order) owns
  // block i of the day. Only the mailbox whose block is running now may send.
  // Resolved BEFORE the daily-cap count below, because "today" starts at midnight in the CLIENT's timezone, not the
  // server's (a server-clock midnight would reset the cap in the middle of the send window for clients whose
  // window crosses UTC midnight, allowing roughly double the intended daily sends).
  const [{ data: clientRow }, { data: campaignRow }] = await Promise.all([
    admin.from("clients").select("*").eq("id", clientId).maybeSingle(),
    admin.from("campaigns")
      .select("send_window_start, send_window_end, timezone, template_subject, template_body")
      .eq("id", campaign.id)
      .maybeSingle<{ send_window_start: string | null; send_window_end: string | null; timezone: string | null; template_subject: string | null; template_body: string | null }>(),
  ]);
  // Campaign overrides fall back to client-level values
  const resolvedTimezone = campaignRow?.timezone ?? clientRow?.timezone;
  const resolvedWindowStart = campaignRow?.send_window_start ?? clientRow?.outreach_send_start;
  const resolvedWindowEnd = campaignRow?.send_window_end ?? clientRow?.outreach_send_end;
  const resolvedTemplateSubject = campaignRow?.template_subject ?? clientRow?.outreach_template_subject;
  const resolvedTemplateBody = campaignRow?.template_body ?? clientRow?.outreach_template_body;

  if (!isValidTimeZone(resolvedTimezone)) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "client timezone not set: choose it in the sending window settings" };
  }
  const sendTz = resolvedTimezone;
  const startOfToday = startOfLocalDay(sendTz);

  // Idempotent daily cap: counts sends already recorded today, so running
  // this route twice in one day (retry, overlapping cron) never sends more
  // than the daily cap total — the cap is enforced against actual
  // outreach_log rows, not an in-memory counter that resets per invocation.
  const { count: sentToday } = await admin
    .from("outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("touch_number", 1)
    .gte("sent_at", startOfToday.toISOString());

  // Optional per-tenant override (column may not exist yet / be null -> historical default of 4).
  const [{ data: capRow }, { data: capMailboxes }] = await Promise.all([
    admin.from("clients").select("daily_send_cap").eq("id", clientId).maybeSingle<{ daily_send_cap: number | null }>(),
    admin.from("mailboxes").select("id, address, daily_send_limit, created_at").eq("client_id", clientId).order("created_at", { ascending: true }).returns<{ id: string; address: string; daily_send_limit: number | null; created_at: string }[]>(),
  ]);
  // Health is computed once here for the capacity estimate; reserveMailboxSlot re-checks per slot atomically.
  const { getUnhealthyMailboxIds: _getUnhealthy } = await import("@/lib/mailbox-health");
  const unhealthyForCap = await _getUnhealthy(admin, clientId);
  const mailboxCapacity = (capMailboxes ?? []).reduce(
    (sum, m) => sum + effectiveDailyLimit(m, Date.now(), !unhealthyForCap.has(m.id)),
    0,
  );
  const dailyCap = resolveDailySendCap(capRow?.daily_send_cap, mailboxCapacity);
  const remaining = dailyCap - (sentToday ?? 0);
  if (remaining <= 0) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "daily limit already reached" };
  }

  if (isSendWindowBroken(resolvedWindowStart, resolvedWindowEnd)) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "send window is invalid (needs 5 minutes to 24 hours, as HH:MM) - sending stays closed until it is fixed in Settings" };
  }
  const sendWindow = resolveSendWindow(resolvedWindowStart, resolvedWindowEnd);
  const usingDefaultWindow = sendWindow === DEFAULT_SEND_WINDOW;
  const nowMinute = localClock(sendTz).minutes;
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const windowLabel = `${fmt(sendWindow.startMin)}-${fmt(sendWindow.endMin)} ${sendTz}${usingDefaultWindow ? " (default)" : ""}`;

  const blockMailboxes = (capMailboxes ?? []) as { id: string; address: string }[];
  if (blockMailboxes.length === 0) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "no mailbox for this client" };
  }
  // The plan follows the daily total and the number of mailboxes. If the total cannot fit the window at the 5-minute
  // floor, the batch uses the most that does fit and reports the shortfall; the rest waits for tomorrow.
  let plan = planBlocks(sendWindow, blockMailboxes.length, dailyCap);
  let pacingWarning: string | undefined;
  if (!plan.feasible) {
    if (plan.maxSends === 0) {
      // Window is too narrow for even one send per mailbox at the minimum gap.
      // Most common cause: many mailboxes with a short send window.
      // Tell the operator clearly rather than silently skipping.
      return {
        clientId,
        campaignId: campaign.id,
        result: "skipped",
        detail: `send window ${windowLabel} is too narrow for ${blockMailboxes.length} mailbox${blockMailboxes.length === 1 ? "" : "es"} — widen the window in Settings → Sending Schedule (need at least ${blockMailboxes.length} hour${blockMailboxes.length === 1 ? "" : "s"} for ${blockMailboxes.length} mailbox${blockMailboxes.length === 1 ? "" : "es"})`,
      };
    }
    plan = planBlocks(sendWindow, blockMailboxes.length, plan.maxSends);
    pacingWarning = `Daily total ${dailyCap} does not fit the ${windowLabel} window at the 5-minute floor; sending ${plan.perMailbox * blockMailboxes.length} today, the rest waits for tomorrow.`;
  }

  const blockIndex = activeBlockIndex(plan, sendWindow, nowMinute);
  if (blockIndex < 0) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: `not inside a mailbox block right now (${windowLabel})` };
  }
  const activeMailbox = blockMailboxes[blockIndex];
  if ((await getMailboxReadiness(activeMailbox.address)) !== "ready") {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: `block mailbox ${activeMailbox.address} is not ready (Mailgun domain not verified)` };
  }

  // This mailbox sends its share once per day: its block is done when it has reached its per-block count.
  const { count: blockSent } = await admin
    .from("outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", activeMailbox.id)
    .eq("touch_number", 1)
    .gte("sent_at", startOfToday.toISOString());
  if ((blockSent ?? 0) >= plan.perMailbox) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "this mailbox's block is already done today" };
  }

  // Planned gap between sends (block length / per-block count, never below the 5-minute floor).
  const { data: lastSentRow } = await admin
    .from("outreach_log")
    .select("sent_at")
    .eq("client_id", clientId)
    .eq("touch_number", 1)
    .gte("sent_at", startOfToday.toISOString())
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ sent_at: string }>();
  if (lastSentRow && stillWaiting(lastSentRow.sent_at, plannedGapMs(plan.gapUsed, lastSentRow.sent_at))) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: `waiting for the planned ${plan.gapUsed}-minute gap` };
  }

  // Only leads the client requested through the lead-gen form (and, when set, created after automation was
  // switched on) are auto-sent; leads saved by default elsewhere are never touched by the scheduler.
  const since = autoSendSince();
  let eligibleQuery = admin
    .from("leads")
    .select("id, name, company, job_title, email, city, country, industry")
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

  const { data: job } = await admin
    .from("lead_gen_jobs")
    .select("criteria")
    .eq("client_id", clientId)
    // A failed or blocked form submission must not replace the pitch of the last one that worked.
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ criteria: Record<string, unknown> }>();

  const sellingDescription = (job?.criteria?.what_you_sell as string | undefined)?.trim();
  if (!sellingDescription) {
    return { clientId, campaignId: campaign.id, result: "skipped", detail: "no saved outreach description (what_you_sell)" };
  }

  const context = await getClientBusinessContext(admin, clientId);
  const businessContext = formatBusinessContext(context);

  // The two variable phrases of the fixed email template are worded once per batch, not per lead.
  const senderCompanyName = clientRow?.company_name ?? "us";
  const phrases = await draftOfferPhrases({ sellingDescription, senderCompany: senderCompanyName, businessContext });
  // Industry is only stated when the campaign targeted exactly one, so it is never guessed per lead.
  const targetIndustries = Array.isArray(job?.criteria?.target_industries) ? (job!.criteria.target_industries as string[]) : [];
  const industry = targetIndustries.length === 1 ? String(targetIndustries[0]) : null;
  const sent: { leadId: string; mailbox: string; result: "sent" | "failed"; error?: string }[] = [];
  // P0 defensive re-check: fetched once per batch, not per lead. Normal
  // operation never hits this (mailbox creation already gates on
  // ownership), but sending is itself a "relevant ... path" per the fix
  // requirements, so it is re-verified here independently rather than
  // trusting that every upstream gate was correctly applied.
  const externalDomains = await getExternalDomainsForClient(admin, clientId);

  // One lead per run: the next planned slot is picked up by the next scheduled run (see pacing above).
  for (let i = 0; i < 1 && i < eligibleLeads.length; i++) {
    const lead = eligibleLeads[i];
    // Never spend a send (and a bounce on the sender's reputation) on an address that cannot receive mail. It is
    // marked undeliverable so it leaves the queue; the next scheduled run picks the next lead.
    const addressCheck = await checkEmailAddress(lead.email);
    if (!addressCheck.ok) {
      await admin.from("leads").update({ email_bounced: true }).eq("id", lead.id);
      sent.push({ leadId: lead.id, mailbox: "-", result: "failed", error: `address check failed: ${addressCheck.reason}` });
      continue;
    }
    // The block's mailbox is the only one allowed here; daily-limit enforcement stays in reserveMailboxSlot (atomic).
    const reservation = await reserveMailboxSlot(admin, clientId, lead.id, { touch_number: 1, campaign_id: campaign.id }, { mailboxId: activeMailbox.id, timeZone: sendTz });
    if (!reservation.ok) {
      sent.push({ leadId: lead.id, mailbox: "-", result: "failed", error: reservation.reason === "duplicate_touch" ? "this lead already has its first email" : reservation.reason === "at_capacity" ? "mailbox daily limit reached" : reservation.reason === "all_unhealthy" ? "all mailboxes paused: high bounce/complaint rate" : "no ready mailbox" });
      break;
    }
    const mailbox = reservation.mailbox;

    const mailboxDomain = mailgunDomainForAddress(mailbox.address);
    const usable = await assertDomainUsableByClient(admin, clientId, mailboxDomain, { requireExplicitOwnership: externalDomains.has(mailboxDomain) });
    if (!usable.usable || (await isDomainDisconnected(admin, clientId, mailboxDomain))) {
      await releaseReservation(admin, reservation.reservationId);
      sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "failed", error: `Domain ${mailboxDomain} is not usable (ownership unverified or disconnected) — send blocked` });
      continue;
    }

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

    // Set the moment Mailgun accepts the email. After that the email IS sent, so no later error may release the slot
    // or put the lead back to "new" (that would email the same person again on the next run).
    let mailSent = false;
    try {
      // Directory leads are businesses, not people: their "name" is the company name, so greet generically.
      const isBusinessLead = !lead.job_title || (lead.name ?? "").trim().toLowerCase() === (lead.company ?? "").trim().toLowerCase();
      const senderCompany = clientRow?.company_name ?? "us";
      // The lead's OWN industry wins; the campaign's single target industry is only a fallback; otherwise none is claimed.
      const leadIndustry = (lead as { industry?: string | null }).industry?.trim() || industry;

      // Try AIDA AI draft first; fall back to fixed template if it fails or fails the lint.
      // This gives each lead a personalised email while keeping deliverability as the hard backstop.
      const fixedDraft = cleanOutreachEmail(
        buildTemplateEmail({
          firstName: isBusinessLead ? null : lead.name,
          leadCompany: lead.company || "your company",
          industry: leadIndustry,
          jobTitle: isBusinessLead ? null : lead.job_title ?? null,
          offer: phrases.offer,
          benefit: phrases.benefit,
          senderCompany,
          website: context.website ?? null,
        })
      );
      let draft = fixedDraft;
      try {
        // Fetch company description from Explorium for richer personalisation.
        // Runs in parallel with nothing else — failure silently returns null
        // and we fall back to the plain businessContext already set above.
        const companyDesc = await fetchCompanyDescriptionViaMcp({
          companyName: lead.company || "",
          companyDomain: null,
        });
        const enrichedContext = companyDesc
          ? `${businessContext ? businessContext + "\n\n" : ""}ABOUT THE LEAD'S COMPANY:\n${companyDesc}`
          : businessContext;

        const aidaDraft = cleanOutreachEmail(
          await draftAidaEmail({
            sellingDescription,
            senderCompany,
            leadName: isBusinessLead ? (lead.company || "there") : (lead.name || "there"),
            leadCompany: lead.company || "your company",
            leadTitle: isBusinessLead ? null : (lead.job_title ?? null),
            leadCity: lead.city ?? null,
            leadCountry: lead.country ?? null,
            leadIndustry,
            businessContext: enrichedContext,
          })
        );
        // Only use the AIDA draft if it passes all deliverability checks; otherwise keep the fixed template.
        const framed = applyGreetingAndSignoff(aidaDraft, { greetingName: isBusinessLead ? null : lead.name, senderName: senderCompany });
        if (lintOutreachEmail(framed, { firstTouch: true, industry: leadIndustry }).length === 0) draft = framed;
      } catch {
        // AIDA generation failed (rate-limit, timeout, etc.) — fixed template is already set.
      }
      if (resolvedTemplateBody && resolvedTemplateSubject) {
        const custom = cleanOutreachEmail(
          renderCustomTemplate(resolvedTemplateSubject, resolvedTemplateBody, {
            first_name: isBusinessLead ? null : lead.name,
            company: lead.company,
            industry: leadIndustry,
            job_title: isBusinessLead ? null : lead.job_title ?? null,
            sender_company: senderCompany,
            website: bareDomain(context.website),
          })
        );
        if (lintOutreachEmail(custom, { firstTouch: true, industry: leadIndustry }).length === 0) draft = custom;
      }
      const issues = lintOutreachEmail(draft, { firstTouch: true, industry: leadIndustry });
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

      mailSent = true;
      await Promise.all([
        finalizeReservation(admin, reservation.reservationId, { messageId: sentMsg.id, subject: draft.subject, body: draft.body }),
        admin
          .from("leads")
          .update({
            status: "email_sent",
            follow_up_number: 1,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at: new Date(Date.now() + resolveFirstFollowUpDelayMs(job?.criteria)).toISOString(),
          })
          .eq("id", lead.id),
      ]);

      sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "sent" });
    } catch (err) {
      if (mailSent) {
        // The email already went out: record that as best we can, never undo it.
        try {
          await admin.from("leads").update({
            status: "email_sent",
            follow_up_number: 1,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at: new Date(Date.now() + resolveFirstFollowUpDelayMs(job?.criteria)).toISOString(),
          }).eq("id", lead.id);
        } catch { /* a later reconciliation sees the sent log row */ }
        sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "sent", error: `email sent, but saving afterwards failed: ${(err as Error).message}` });
        continue;
      }
      await releaseReservation(admin, reservation.reservationId);
      await admin.from("leads").update({ last_contact_at: null }).eq("id", lead.id).eq("status", "new");
      // One lead failing (bad address, Mailgun hiccup) doesn't stop the rest
      // of today's batch — it just stays "new" for tomorrow's run to retry.
      sent.push({ leadId: lead.id, mailbox: mailbox.address, result: "failed", error: (err as Error).message });
    }
  }

  const successCount = sent.filter((s) => s.result === "sent").length;
  if (successCount > 0) {
    await admin
      .from("campaigns")
      .update({ sent_count: (campaign.sent_count ?? 0) + successCount })
      .eq("id", campaign.id);
  }

  return { clientId, campaignId: campaign.id, result: "processed", sent, ...(pacingWarning ? { warning: pacingWarning } : {}) };
}

