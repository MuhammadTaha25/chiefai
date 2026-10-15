/**
 * Daily first-email cap per tenant.
 *
 * Three cases:
 *
 * 1. No override set  →  use mailboxCapacity (sum of per-mailbox warmup limits).
 *    If mailboxCapacity is also 0 (no mailboxes configured yet), fall back to 4
 *    so a brand-new tenant still sees the historical safe default.
 *
 * 2. Override set, mailboxCapacity > 0  →  cap at the SMALLER of override and
 *    what the mailboxes can actually deliver today.  This prevents the override
 *    from pushing a single mailbox beyond its warmup ramp.
 *
 * 3. Override set, mailboxCapacity = 0  →  use the override as-is.  The mailboxes
 *    don't have per-mailbox limits stored but the tenant has explicitly asked for a
 *    total; the warmup guard is already baked into effectiveDailyLimit (called
 *    upstream) so we trust it here.
 */
export const DEFAULT_DAILY_INITIAL_SEND_LIMIT = 4;

export function resolveDailySendCap(override: number | null | undefined, mailboxCapacity: number): number {
  const cap = Math.max(0, Math.floor(mailboxCapacity));

  // No override → honour whatever the mailboxes collectively allow.
  if (!override || !Number.isFinite(override) || override <= 0) {
    return cap > 0 ? cap : DEFAULT_DAILY_INITIAL_SEND_LIMIT;
  }

  const overrideSafe = Math.floor(override);

  // Override set + mailboxes have capacity → bounded by the lower of the two.
  if (cap > 0) return Math.min(overrideSafe, cap);

  // Override set + no per-mailbox limits stored → trust the override directly.
  return overrideSafe;
}
