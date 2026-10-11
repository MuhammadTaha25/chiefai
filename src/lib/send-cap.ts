/**
 * Daily first-email cap per tenant. Additive on purpose: with no override the cap is the historical constant (4),
 * so existing tenants behave exactly as before. A tenant with clients.daily_send_cap set (e.g. 150) is capped by
 * the SMALLER of that number and what its own mailboxes can actually send today (sum of their warmup-limited
 * daily limits), so the cap can never push a mailbox past its warmup ramp.
 */
export const DEFAULT_DAILY_INITIAL_SEND_LIMIT = 4;

export function resolveDailySendCap(override: number | null | undefined, mailboxCapacity: number): number {
  if (!override || !Number.isFinite(override) || override <= 0) return DEFAULT_DAILY_INITIAL_SEND_LIMIT;
  return Math.max(0, Math.min(Math.floor(override), Math.max(0, Math.floor(mailboxCapacity))));
}
