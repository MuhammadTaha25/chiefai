import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Mailbox reputation guard. A mailbox whose recent mail bounces or draws spam complaints is the one most
 * likely to be landing in spam, and every further send makes it worse. Sending is shifted to the tenant's
 * other healthy mailboxes instead (reserveMailboxSlot / pickReadyMailbox skip unhealthy ones).
 *
 * Signals come from data we already store: outreach_log (what each mailbox sent) joined to the lead flags the
 * Mailgun events webhook sets (email_bounced, complained). Inbox-vs-spam placement itself is not exposed by
 * Mailgun; bounce/complaint rate is the measurable proxy.
 */
export const HEALTH_WINDOW_DAYS = 7;
/** Below this many sends there is not enough data to judge; the mailbox stays eligible. */
export const MIN_SENDS_TO_JUDGE = 15;
/** Stricter than Mailgun's own limits (5% bounces, 0.08% complaints) so we pause before the provider acts. */
export const MAX_BOUNCE_RATE = 0.04;
export const MAX_COMPLAINT_RATE = 0.001;
/** Even with too few sends for a rate, this many bounces this early means the list or domain is bad. */
export const EARLY_BOUNCE_LIMIT = 3;

/** Early-warning level: below the pause line but already drifting, so sending slows down (see isMailboxSlow). */
export const WARN_BOUNCE_RATE = 0.02;
/** Minimum sends before the early warning is trusted (a single bounce in 3 sends is noise). */
export const MIN_SENDS_TO_WARN = 10;

export interface MailboxStats {
  sent: number;
  bounced: number;
  complained: number;
}

export function isMailboxHealthy(s: MailboxStats): boolean {
  if (s.sent < MIN_SENDS_TO_JUDGE) {
    // Too little data for a rate, but two spam complaints this early is already a red flag.
    return s.complained < 2 && s.bounced < EARLY_BOUNCE_LIMIT;
  }
  return s.bounced / s.sent <= MAX_BOUNCE_RATE && s.complained / s.sent <= MAX_COMPLAINT_RATE;
}

/**
 * Healthy enough to keep sending, but the bounce rate is already at the warning level: the daily limit is halved
 * until it recovers instead of letting the age-based ramp keep climbing.
 */
export function isMailboxSlow(s: MailboxStats): boolean {
  if (!isMailboxHealthy(s)) return false; // already paused, nothing to slow
  return s.sent >= MIN_SENDS_TO_WARN && s.bounced / s.sent >= WARN_BOUNCE_RATE;
}

export interface MailboxHealthSets {
  /** Paused from new sends. */
  unhealthy: Set<string>;
  /** Still sending, at half the daily limit. */
  slow: Set<string>;
}

/**
 * Receivers keep reputation per DOMAIN, so every mailbox on a domain is judged twice: on its own numbers, and on the
 * sum of all mailboxes sharing the domain. Eight mailboxes each sitting just under the per-mailbox limit are one
 * domain with eight times the bounces. A domain that fails pauses ALL its mailboxes; one that only warns slows them all.
 * Pure: `stats` is per mailbox id, `domainOf` maps every mailbox id of the client to its sending domain.
 */
export function computeMailboxHealth(stats: Map<string, MailboxStats>, domainOf: Map<string, string>): MailboxHealthSets {
  const unhealthy = new Set<string>();
  const slow = new Set<string>();
  for (const [id, s] of stats) {
    if (!isMailboxHealthy(s)) unhealthy.add(id);
    else if (isMailboxSlow(s)) slow.add(id);
  }
  const byDomain = new Map<string, MailboxStats>();
  for (const [id, s] of stats) {
    const d = domainOf.get(id);
    if (!d) continue;
    const t = byDomain.get(d) ?? { sent: 0, bounced: 0, complained: 0 };
    t.sent += s.sent;
    t.bounced += s.bounced;
    t.complained += s.complained;
    byDomain.set(d, t);
  }
  for (const [d, total] of byDomain) {
    const bad = !isMailboxHealthy(total);
    const warn = isMailboxSlow(total);
    if (!bad && !warn) continue;
    for (const [id, dom] of domainOf) {
      if (dom !== d) continue;
      if (bad) {
        unhealthy.add(id);
        slow.delete(id);
      } else if (!unhealthy.has(id)) slow.add(id);
    }
  }
  return { unhealthy, slow };
}

/** Ids of this client's mailboxes that should be paused from NEW sales sends right now. */
export async function getUnhealthyMailboxIds(admin: SupabaseClient, clientId: string): Promise<Set<string>> {
  return (await getMailboxHealth(admin, clientId)).unhealthy;
}

/** Pause and slow-down sets for this client's mailboxes (own numbers plus the whole domain's). */
export async function getMailboxHealth(admin: SupabaseClient, clientId: string): Promise<MailboxHealthSets> {
  const since = new Date(Date.now() - HEALTH_WINDOW_DAYS * 86400000).toISOString();
  const { data } = await admin
    .from("outreach_log")
    .select("mailbox_id, lead_id")
    .eq("client_id", clientId)
    .not("mailbox_id", "is", null)
    .gte("touch_number", 1)
    .gte("sent_at", since)
    .limit(5000)
    .returns<{ mailbox_id: string; lead_id: string | null }[]>();
  const rows = data ?? [];
  if (rows.length === 0) return { unhealthy: new Set(), slow: new Set() };

  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter((x): x is string => Boolean(x)))];
  const flagged = new Map<string, { bounced: boolean; complained: boolean }>();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data: leads } = await admin
      .from("leads")
      .select("id, email_bounced, complained")
      .in("id", leadIds.slice(i, i + 200))
      .returns<{ id: string; email_bounced: boolean | null; complained: boolean | null }[]>();
    for (const l of leads ?? []) flagged.set(l.id, { bounced: Boolean(l.email_bounced), complained: Boolean(l.complained) });
  }

  const stats = new Map<string, MailboxStats>();
  for (const r of rows) {
    const s = stats.get(r.mailbox_id) ?? { sent: 0, bounced: 0, complained: 0 };
    s.sent += 1;
    const f = r.lead_id ? flagged.get(r.lead_id) : undefined;
    if (f?.bounced) s.bounced += 1;
    if (f?.complained) s.complained += 1;
    stats.set(r.mailbox_id, s);
  }
  const { data: boxes } = await admin
    .from("mailboxes")
    .select("id, address")
    .eq("client_id", clientId)
    .returns<{ id: string; address: string }[]>();
  const domainOf = new Map<string, string>();
  for (const b of boxes ?? []) domainOf.set(b.id, b.address.slice(b.address.lastIndexOf("@") + 1).trim().toLowerCase());
  return computeMailboxHealth(stats, domainOf);
}
