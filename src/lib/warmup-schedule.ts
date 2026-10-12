/**
 * Cold-email warm-up schedule. Day 0 = the mailbox was created. Every email is still cold outreach; the warm-up
 * is only about VOLUME: a new mailbox starts small and grows step by step, so it never looks like a spam blast.
 *  - days 0-6   (week 1): 5 per day
 *  - days 7-13  (week 2): 10 per day
 *  - days 14-20 (week 3): 15 per day
 *  - days 21-27 (week 4): 25 per day
 *  - day 28+:            WARMUP_CAP (30) per mailbox; add more mailboxes for more volume rather than raising the cap
 *
 * Pure on purpose (no imports) so it can be tested without the app's path aliases.
 */
export const WARMUP_CAP = 30;

export function coldLimitForAge(ageDays: number): number {
  if (ageDays < 7) return 5;
  if (ageDays < 14) return 10;
  if (ageDays < 21) return 15;
  if (ageDays < 28) return 25;
  return WARMUP_CAP;
}

/**
 * Today's cold-send limit for one mailbox. The stored daily_send_limit is kept as a floor, so a tenant's configured
 * value never shrinks (no regression for mailboxes already past warm-up); the schedule only controls how fast a NEW
 * mailbox ramps.
 */
export function effectiveDailyLimit(m: { daily_send_limit: number | null; created_at?: string | null }, now = Date.now()): number {
  const base = Math.max(0, m.daily_send_limit ?? 0);
  if (base === 0) return 0;
  const ageDays = m.created_at ? Math.max(0, Math.floor((now - new Date(m.created_at).getTime()) / 86400000)) : 0;
  return Math.max(base, coldLimitForAge(ageDays));
}
