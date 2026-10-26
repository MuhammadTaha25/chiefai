import { activeBlockIndex, formatMinute, isSendWindowBroken, planBlocks, resolveSendWindow } from "@/lib/send-window";

/**
 * What the dashboard "Sending health" card says, as one plain sentence plus details. Pure (no database, no clock):
 * the loader gathers the numbers, this decides the message. It reads the same plan the scheduler uses
 * (planBlocks / activeBlockIndex) so the card never contradicts what the scheduler does.
 *
 * Levels: "bad" = something is broken and needs the client's action, "warn" = sending is not set up yet,
 * "ok" = working (including normal waits such as a break between mailbox blocks).
 */
export interface DomainHealthRow {
  domain: string;
  dns_status: string | null;
  dns_health?: { problem?: string; checks: { kind: string; status: string }[] } | null;
}

export interface SendingHealthInput {
  campaignActive: boolean;
  timezoneValid: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  /** Minutes since local midnight in the client's timezone. */
  nowMinute: number;
  /** In creation order: mailbox i owns block i of the day. */
  mailboxes: { id: string; address: string }[];
  dailyCap: number;
  sentToday: number;
  /** First-touch sends today per mailbox id. */
  sentTodayByMailbox: Record<string, number>;
  eligibleLeads: number;
  domains: DomainHealthRow[];
}

export interface SendingHealth {
  level: "ok" | "warn" | "bad";
  headline: string;
  details: string[];
}

const CHECK_LABEL: Record<string, string> = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC", mx: "MX", tracking: "Tracking" };

/**
 * Splits domain trouble in two. "blocking" = this domain cannot send now and it matters (an active domain whose DNS
 * check fails, a domain missing in Mailgun, or NO domain is active at all). "notReady" = an extra domain that is
 * still pending/provisioning while another domain is active and sending: worth a note, not an alarm.
 */
export function domainIssues(domains: DomainHealthRow[]): { blocking: string[]; notReady: string[] } {
  const blocking: string[] = [];
  const notReady: string[] = [];
  const anyActive = domains.some((d) => d.dns_status === "active");
  for (const d of domains) {
    if (d.dns_health?.problem === "not_in_mailgun") {
      blocking.push(`${d.domain} is not set up in Mailgun, so it cannot send. Reconnect or re-provision it in Settings.`);
      continue;
    }
    if (d.dns_status && d.dns_status !== "active") {
      const line = `${d.domain} is not active yet (status: ${d.dns_status}). Open Settings > Domains to finish it.`;
      (anyActive ? notReady : blocking).push(line);
      continue;
    }
    const failing = (d.dns_health?.checks ?? []).filter((c) => c.status !== "ok");
    if (failing.length > 0) {
      const names = failing.map((c) => CHECK_LABEL[c.kind.toLowerCase()] ?? c.kind.toUpperCase()).join(", ");
      blocking.push(`${d.domain}: DNS check failed for ${names}. Open Settings > Domains to see what to fix.`);
    }
  }
  return { blocking, notReady };
}

export function buildSendingHealth(i: SendingHealthInput): SendingHealth {
  const base = buildCore(i);
  const { notReady } = domainIssues(i.domains);
  if (base.level === "bad" || notReady.length === 0) return base;
  return {
    level: "warn",
    headline: base.level === "ok" ? `${base.headline} One extra domain is not ready yet.` : base.headline,
    details: [...base.details, ...notReady],
  };
}

function buildCore(i: SendingHealthInput): SendingHealth {
  const broken: string[] = [];
  if (!i.timezoneValid) broken.push("Your timezone is not set. Choose it in Settings > Sending schedule, otherwise nothing is sent.");
  else if (isSendWindowBroken(i.windowStart, i.windowEnd)) broken.push("Your sending window is invalid (it must be between 5 minutes and 24 hours). Fix it in Settings > Sending schedule, otherwise nothing is sent.");
  if (i.mailboxes.length === 0) broken.push("You have no mailbox yet, so nothing can be sent.");
  broken.push(...domainIssues(i.domains).blocking);
  if (broken.length > 0) {
    return { level: "bad", headline: "Sending needs your attention", details: broken };
  }

  if (!i.campaignActive) {
    return { level: "warn", headline: "No active campaign this month, so no emails are going out.", details: [] };
  }
  if (i.sentToday >= i.dailyCap) {
    return { level: "ok", headline: `Today's limit is reached (${i.sentToday} of ${i.dailyCap}). Sending continues tomorrow.`, details: [] };
  }

  const window = resolveSendWindow(i.windowStart, i.windowEnd);
  let plan = planBlocks(window, i.mailboxes.length, i.dailyCap);
  if (!plan.feasible) {
    if (plan.maxSends === 0) {
      return { level: "bad", headline: "Sending needs your attention", details: ["Your sending window is too short for the number of mailboxes. Widen it in Settings > Sending schedule."] };
    }
    plan = planBlocks(window, i.mailboxes.length, plan.maxSends);
  }

  const idx = activeBlockIndex(plan, window, i.nowMinute);
  if (idx < 0) {
    const rel = (((i.nowMinute - window.startMin) % 1440) + 1440) % 1440;
    const next = plan.windows.find((w) => w.startMin - window.startMin > rel);
    return {
      level: "ok",
      headline: next
        ? `Working. A short break between mailboxes; the next sends start around ${formatMinute(next.startMin)}.`
        : "Working. Today's sending window is over; sending continues tomorrow.",
      details: [],
    };
  }

  const mailbox = i.mailboxes[idx];
  if ((i.sentTodayByMailbox[mailbox.id] ?? 0) >= plan.perMailbox) {
    return { level: "ok", headline: "Working. This mailbox has sent its share for today; the next mailbox takes over after a short break.", details: [] };
  }
  if (i.eligibleLeads === 0) {
    return { level: "ok", headline: "Working. No new leads are waiting to be contacted right now.", details: [] };
  }
  return { level: "ok", headline: `Sending is working. ${i.eligibleLeads} lead${i.eligibleLeads === 1 ? " is" : "s are"} waiting; emails go out about ${plan.gapUsed} minutes apart.`, details: [] };
}
