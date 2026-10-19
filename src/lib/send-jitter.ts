/**
 * Random-looking but repeatable gaps between sends. A fixed gap (exactly 5:00 between every mail) is a robot pattern;
 * a person's gaps vary. The "random" value comes from a hash of a seed (the previous send's time), so it is stable
 * while we wait (the cron checks every few minutes and must reach the same answer each time) and different after each
 * new send. Pure: no imports, no clock, no Math.random.
 */
export function seededUnit(seed: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000; // [0, 1)
}

/** Follow-up pacing: the required wait after a client's last send, between `minMs` and `minMs + spreadMs` (default 3-10 min). */
export function followUpGapMs(seed: string, minMs = 3 * 60_000, spreadMs = 7 * 60_000): number {
  return Math.round(minMs + spreadMs * seededUnit(seed));
}

/**
 * First-email pacing: the planned gap shortened by 0-66% (never longer, so the day's planned total still fits),
 * never below `floorMinutes` (the cron grid). With the cron ticking every 5 minutes the real gap lands on 5, 10 or 15.
 */
export function plannedGapMs(plannedMinutes: number, seed: string, floorMinutes = 5): number {
  const factor = 0.6 + 0.4 * seededUnit(seed);
  return Math.max(floorMinutes, plannedMinutes * factor) * 60_000;
}

/**
 * The cron fires on a 5-minute grid but a send is stamped a few seconds after its tick, so by the next tick only
 * 4:5x has passed. A minute of tolerance lets "5 minutes" mean the next tick instead of the one after.
 */
export const TICK_TOLERANCE_MS = 60_000;

/** True while the previous send is still too recent for the required gap. */
export function stillWaiting(lastSentAtIso: string, requiredMs: number, nowMs = Date.now()): boolean {
  return nowMs - Date.parse(lastSentAtIso) + TICK_TOLERANCE_MS < requiredMs;
}
