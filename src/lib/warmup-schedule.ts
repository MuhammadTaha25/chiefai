/**
 * Cold-email warm-up schedule. Day 0 = the mailbox was created. Every email is still cold outreach; the warm-up
 * is only about VOLUME: a new mailbox starts small and ramps smoothly, so it never looks like a spam blast.
 *
 * EXPONENTIAL RAMP (replaces abrupt weekly jumps):
 *   V(d) = min(WARMUP_CAP, floor(4 + 46 × (1 − e^(−d/30))))
 *
 *   d=0  →  4   d=7  →  13   d=14 →  21   d=21 →  27   d=25+ → 30  (full volume in about 3.5 weeks)
 *
 * The curve starts conservatively, accelerates through the critical first-two-weeks
 * reputation-building period, then flattens near the cap — matching how ESPs
 * (Google Postmaster, SNDS) actually build trust.
 *
 * HEALTH GATE: a mailbox whose bounce/complaint rate is above threshold is NOT
 * auto-graduated even when age alone would allow it. The caller must check health
 * separately (mailbox-health.ts → isMailboxHealthy) and pass `healthy`.
 *
 * Pure on purpose (no imports) so it can be tested without the app's path aliases.
 */
export const WARMUP_CAP = 30;

/**
 * Max emails/day at age `ageDays` for a HEALTHY mailbox.
 * Uses an exponential approach curve that avoids abrupt weekly jumps.
 */
export function coldLimitForAge(ageDays: number): number {
  const d = Math.max(0, ageDays);
  return Math.min(WARMUP_CAP, Math.floor(4 + 46 * (1 - Math.exp(-d / 30))));
}

/**
 * Today's cold-send limit for one mailbox.
 *
 * `healthy` — pass `false` when the mailbox's recent bounce/complaint rate is
 * above threshold (from mailbox-health.ts → isMailboxHealthy). An unhealthy mailbox
 * is held at its current limit rather than being auto-graduated, preventing the
 * warmup schedule from quietly escalating volume on a mailbox that is already
 * damaging sender reputation. Pass `true` (or omit) when health is confirmed or
 * when there is not yet enough data to judge.
 *
 * During the warm-up period the warmup curve is a hard CEILING — a high
 * daily_send_limit cannot bypass it. Once the mailbox has fully warmed up
 * (scheduleLimit === WARMUP_CAP) the configured limit takes over as the cap,
 * so operators can set a value above 30 for mature mailboxes if they choose.
 *
 * If daily_send_limit is null or 0 (not yet set by the operator), the warmup
 * curve is used directly — the mailbox still participates in sending even when
 * the UI field hasn't been filled in.
 */
export function effectiveDailyLimit(
  m: { daily_send_limit: number | null; created_at?: string | null },
  now = Date.now(),
  healthy = true,
  slow = false,
): number {
  const limit = baseDailyLimit(m, now, healthy);
  // Early warning (bounce rate drifting up): half the limit instead of letting the ramp keep climbing.
  return slow && limit > 0 ? Math.max(1, Math.ceil(limit / 2)) : limit;
}

/**
 * Domain-wide daily ceiling by the domain's age (days since its oldest mailbox was created). Receivers judge
 * reputation per domain, so several young mailboxes each ramping on their own must not add up to a burst:
 *   cap(d) = min(ceiling, floor(20 + 80 × (1 − e^(−d/21))))   d=0 → 20, d=10 → 50, d=25 → 76, d=45 → 90
 * `ceiling` is the operator's DOMAIN_DAILY_SEND_CAP (default 100).
 */
export function domainCapForAge(ageDays: number, ceiling: number): number {
  const d = Math.max(0, ageDays);
  return Math.min(ceiling, Math.floor(20 + 80 * (1 - Math.exp(-d / 21))));
}

function baseDailyLimit(
  m: { daily_send_limit: number | null; created_at?: string | null },
  now: number,
  healthy: boolean,
): number {
  const ageDays = m.created_at
    ? Math.max(0, Math.floor((now - new Date(m.created_at).getTime()) / 86400000))
    : 0;
  const scheduleLimit = coldLimitForAge(ageDays);

  const base = Math.max(0, m.daily_send_limit ?? 0);

  // No per-mailbox limit set → warmup curve is the sole limit.
  if (base === 0) return scheduleLimit;

  // Unhealthy mailbox: hold at the lower of the configured limit and the
  // warmup curve — no graduation while reputation is damaged.
  if (!healthy) return Math.min(base, scheduleLimit);

  // During warm-up: warmup curve is a hard ceiling regardless of configured limit.
  // Once fully warmed (scheduleLimit === WARMUP_CAP), honour the configured limit
  // so operators can scale beyond 30 on mature mailboxes.
  if (scheduleLimit < WARMUP_CAP) return Math.min(base, scheduleLimit);

  // Fully warmed: configured limit wins (operator chose a higher cap).
  return Math.max(base, scheduleLimit);
}

/**
 * Plain-language explanation of one mailbox's daily limit, for the Domains page. `warmup_day` stored on the
 * mailbox is only ever set to 1 at creation, so the real stage comes from the mailbox's AGE, the same input the
 * sending limit uses. `limitedBy` says which rule is holding sends back right now:
 *   "configured" - the limit saved on the mailbox is lower than what warm-up would allow (or an operator's higher
 *                  cap on a fully warmed mailbox), so raising it is what lets more email out;
 *   "warm-up"    - the age-based ramp is the ceiling, whatever the saved limit says;
 *   "none"       - fully warmed and not capped by the saved limit.
 * Same assumptions as effectiveDailyLimit with a healthy mailbox.
 */
export function describeMailboxLimit(
  m: { daily_send_limit: number | null; created_at?: string | null },
  now = Date.now(),
): {
  ageDays: number;
  stageDay: number;
  warmedUp: boolean;
  daysUntilWarmed: number;
  warmupAllows: number;
  configured: number;
  effective: number;
  limitedBy: "configured" | "warm-up" | "none";
} {
  const ageDays = m.created_at ? Math.max(0, Math.floor((now - new Date(m.created_at).getTime()) / 86400000)) : 0;
  const warmupAllows = coldLimitForAge(ageDays);
  const configured = Math.max(0, m.daily_send_limit ?? 0);
  const effective = effectiveDailyLimit(m, now, true);
  const warmedUp = warmupAllows >= WARMUP_CAP;
  let daysUntilWarmed = 0;
  if (!warmedUp) {
    let d = ageDays;
    while (coldLimitForAge(d) < WARMUP_CAP && d < ageDays + 365) d++;
    daysUntilWarmed = d - ageDays;
  }
  let limitedBy: "configured" | "warm-up" | "none";
  if (warmedUp) limitedBy = configured > warmupAllows ? "configured" : "none";
  else if (configured === 0) limitedBy = "warm-up";
  else limitedBy = configured < warmupAllows ? "configured" : "warm-up";
  return { ageDays, stageDay: ageDays + 1, warmedUp, daysUntilWarmed, warmupAllows, configured, effective, limitedBy };
}
