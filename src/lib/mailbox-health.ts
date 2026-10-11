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
export const MAX_BOUNCE_RATE = 0.08;
export const MAX_COMPLAINT_RATE = 0.003;

export interface MailboxStats {
  sent: number;
  bounced: number;
  complained: number;
}

export function isMailboxHealthy(s: MailboxStats): boolean {
  if (s.sent < MIN_SENDS_TO_JUDGE) {
    // Too little data for a rate, but two spam complaints this early is already a red flag.
    return s.complained < 2;
  }
  return s.bounced / s.sent <= MAX_BOUNCE_RATE && s.complained / s.sent <= MAX_COMPLAINT_RATE;
}

/** Ids of this client's mailboxes that should be paused from NEW sales sends right now. */
export async function getUnhealthyMailboxIds(admin: SupabaseClient, clientId: string): Promise<Set<string>> {
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
  if (rows.length === 0) return new Set();

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
  const unhealthy = new Set<string>();
  for (const [id, s] of stats) if (!isMailboxHealthy(s)) unhealthy.add(id);
  return unhealthy;
}
