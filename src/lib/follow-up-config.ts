/**
 * Shared follow-up cadence configuration — single source of truth for both
 * the initial send (send-batch.ts) and the recurring follow-up cron
 * (follow-ups.ts), so the two can never silently diverge.
 *
 * Default cadence is 3 days between touches (typical B2B outreach cadence).
 * A platform operator can change the default via FOLLOW_UP_INTERVAL_DAYS; a
 * client can further override their own cadence via the lead-gen criteria's
 * `follow_up_delay_days` field, which takes priority when present and valid.
 */

const DEFAULT_FOLLOW_UP_INTERVAL_DAYS = 3;
// ~15 minutes floor — low enough for QA/manual testing, high enough that a
// garbled value (e.g. 0) can never produce an effectively-immediate resend.
const MIN_FOLLOW_UP_INTERVAL_DAYS = 0.01;
// Sanity ceiling — a value this far out is almost certainly a data-entry
// mistake, not an intentional cadence.
const MAX_FOLLOW_UP_INTERVAL_DAYS = 30;

function inRange(days: number): boolean {
  return Number.isFinite(days) && days >= MIN_FOLLOW_UP_INTERVAL_DAYS && days <= MAX_FOLLOW_UP_INTERVAL_DAYS;
}

function platformDefaultDays(): number {
  const raw = Number(process.env.FOLLOW_UP_INTERVAL_DAYS);
  return inRange(raw) ? raw : DEFAULT_FOLLOW_UP_INTERVAL_DAYS;
}

/**
 * Resolves the follow-up interval, in milliseconds, for one client/campaign
 * given their lead-gen criteria (if any). A client-set `follow_up_delay_days`
 * wins when it parses to a finite number inside the sane range; anything
 * else (missing, NaN, out of range) falls back to the platform default —
 * never to an unvalidated raw value.
 */
export function resolveFollowUpIntervalMs(criteria?: Record<string, unknown> | null): number {
  const raw = criteria?.["follow_up_delay_days"];
  const days = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  const resolvedDays = inRange(days) ? days : platformDefaultDays();
  return resolvedDays * 24 * 60 * 60 * 1000;
}

/**
 * Delay before the FIRST follow-up after the initial send. Same resolution
 * rule as subsequent follow-ups — kept as a distinct export so a future
 * product decision to diverge the two has one obvious place to do it,
 * without the two files reaching for different constants again.
 */
export function resolveFirstFollowUpDelayMs(criteria?: Record<string, unknown> | null): number {
  return resolveFollowUpIntervalMs(criteria);
}

/**
 * Where a lead is in its sequence, given the `follow_up_number` stored on it.
 *
 * `follow_up_number` counts the INITIAL email as 1 (every send path sets it to 1 on the first email), so it is NOT
 * "follow-ups sent so far". This one helper keeps the cron's cap, touch number, status and email angle consistent:
 *   - nextFollowUpNumber: the value stored on the lead after this send, and this email's touch_number (initial = touch 1)
 *   - followUpIndex:      this email's position among FOLLOW-UPS only (1 = first follow-up)
 *   - capped:             the client's follow-up allowance is already used up — send nothing
 *   - isLast:             this send is the final follow-up allowed — schedule no further one
 *   - status:             `follow_up_<followUpIndex>` (same meaning as the manual send route)
 */
export function planFollowUp(storedFollowUpNumber: number | null | undefined, maxFollowUps: number) {
  const nextFollowUpNumber = (storedFollowUpNumber ?? 0) + 1;
  const followUpIndex = nextFollowUpNumber - 1;
  return {
    nextFollowUpNumber,
    followUpIndex,
    capped: followUpIndex > maxFollowUps,
    isLast: followUpIndex >= maxFollowUps,
    status: `follow_up_${Math.min(followUpIndex, 10)}`,
  };
}
