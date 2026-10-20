/**
 * Daily sending timeline for cold email (pure: no database, no sending, no imports).
 *
 * A day is split into SEND WINDOWS (local minutes after midnight, end exclusive). Each window is used by ONE mailbox
 * in turn (round-robin), and sends inside a window are spread out with a minimum gap, so the day looks like a person
 * working through the list, not a burst. Between windows there are natural breaks.
 *
 * The client's chosen start time moves the whole timeline and keeps its shape (window lengths, breaks) unchanged.
 */

export interface SendWindow {
  startMin: number;
  endMin: number;
}

export interface MailboxCapacity {
  id: string;
  /** Sends this mailbox may still make today (already net of its warm-up limit and what it sent earlier). */
  remaining: number;
}

export interface PlannedSend {
  /** Local minutes after midnight. */
  minute: number;
  mailboxId: string;
}

/** Preferred minimum minutes between two sends inside a window. */
export const MIN_GAP_MINUTES = 15;
/** Lowest gap the planner will use to fit a daily total into the day. Below this, sends look like a burst. */
export const FLOOR_GAP_MINUTES = 5;

/**
 * Jitter fraction applied to evenly-spaced send times. ±30% of the spacing interval
 * is added so sends do not land on identical clock times every day (which ESPs notice).
 * Clamped so the jittered minute stays inside [windowStart, windowEnd).
 *
 * Deterministic given a seed so tests can verify the output; in production pass
 * Math.random() (the default).
 */
export const JITTER_FRACTION = 0.3;

export function applyJitter(
  minute: number,
  spacingMinutes: number,
  windowStart: number,
  windowEnd: number,
  rand = Math.random(),
): number {
  const maxShift = Math.floor(spacingMinutes * JITTER_FRACTION);
  if (maxShift === 0) return minute;
  // rand in [0,1) → shift in [-maxShift, +maxShift]
  const shift = Math.round((rand * 2 - 1) * maxShift);
  return Math.max(windowStart, Math.min(windowEnd - 1, minute + shift));
}

/** Recommended default: three windows with breaks in between (08-12, 14-16, 18-20). Client can change these. */
export const RECOMMENDED_WINDOWS: SendWindow[] = [
  { startMin: 8 * 60, endMin: 12 * 60 },
  { startMin: 14 * 60, endMin: 16 * 60 },
  { startMin: 18 * 60, endMin: 20 * 60 },
];

/** Moves the whole timeline so its first window starts at newStartMin; the length of every window and every break is kept. */
export function shiftWindows(windows: SendWindow[], newStartMin: number): SendWindow[] {
  if (windows.length === 0) return [];
  const offset = newStartMin - windows[0].startMin;
  return windows.map((w) => ({ startMin: w.startMin + offset, endMin: w.endMin + offset }));
}

/**
 * Plans one day. Each window (in order) is given to the next mailbox that still has capacity; that mailbox sends up
 * to the window's size (at most one send per gap), spaced evenly across the window. Stops when the day's total is
 * reached or no mailbox has capacity left.
 */
export function planSendsForDay(opts: {
  windows: SendWindow[];
  mailboxes: MailboxCapacity[];
  total: number;
  minGapMinutes?: number;
}): PlannedSend[] {
  const gap = Math.max(1, opts.minGapMinutes ?? MIN_GAP_MINUTES);
  const remaining = new Map(opts.mailboxes.map((m) => [m.id, Math.max(0, Math.floor(m.remaining))]));
  const order = opts.mailboxes.map((m) => m.id);
  let total = Math.max(0, Math.floor(opts.total));
  let cursor = 0;
  const out: PlannedSend[] = [];

  for (const w of opts.windows) {
    if (total === 0) break;
    const length = w.endMin - w.startMin;
    if (length <= 0) continue;

    // Next mailbox (round-robin) that still has capacity.
    let picked: string | null = null;
    for (let i = 0; i < order.length; i++) {
      const idx = (cursor + i) % order.length;
      if ((remaining.get(order[idx]) ?? 0) > 0) {
        picked = order[idx];
        cursor = idx + 1;
        break;
      }
    }
    if (!picked) break;

    const windowCap = Math.floor(length / gap);
    const n = Math.min(windowCap, remaining.get(picked) ?? 0, total);
    if (n <= 0) continue;
    const spacing = length / n;
    for (let k = 0; k < n; k++) {
      const base = w.startMin + Math.floor(k * spacing);
      out.push({ minute: applyJitter(base, spacing, w.startMin, w.endMin), mailboxId: picked });
    }
    remaining.set(picked, (remaining.get(picked) ?? 0) - n);
    total -= n;
  }
  return out;
}

export function formatMinute(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Dynamic plan for ANY number of mailboxes and ANY daily total (nothing is fixed to 5 mailboxes or 50 emails).
 * Model: each mailbox gets one block per day, sized to its share of the total; blocks follow each other with a break.
 * The planner keeps the requested total. If the blocks do not fit at the preferred gap, it lowers the gap (never below
 * FLOOR_GAP_MINUTES) until they fit, and reports the gap it used. Only if even the floor gap cannot fit the total does
 * it report infeasible, with the most it can send.
 */
export interface DynamicPlanInput {
  total: number;
  mailboxCount: number;
  startMin?: number;
  endMin?: number;
  gapMinutes?: number;
  floorGapMinutes?: number;
  breakMinutes?: number;
}

export interface DynamicPlan {
  windows: SendWindow[];
  perMailbox: number;
  feasible: boolean;
  /** Gap actually used between sends inside a block. */
  gapUsed: number;
  /** Most sends this mailbox count can make in the day at the floor gap. */
  maxSends: number;
}

export function buildDynamicPlan(input: DynamicPlanInput): DynamicPlan {
  const n = Math.max(1, Math.floor(input.mailboxCount));
  const start = input.startMin ?? 8 * 60;
  const end = input.endMin ?? 20 * 60;
  const preferred = Math.max(1, input.gapMinutes ?? MIN_GAP_MINUTES);
  const floor = Math.max(1, Math.min(input.floorGapMinutes ?? FLOOR_GAP_MINUTES, preferred));
  const brk = Math.max(0, input.breakMinutes ?? 60);
  const day = Math.max(0, end - start);
  const total = Math.max(0, Math.floor(input.total));
  const perMailbox = Math.ceil(total / n);
  const available = day - (n - 1) * brk;

  const layout = (gap: number): SendWindow[] => {
    const windows: SendWindow[] = [];
    let t = start;
    for (let i = 0; i < n; i++) {
      windows.push({ startMin: t, endMin: t + perMailbox * gap });
      t += perMailbox * gap + brk;
    }
    return windows;
  };

  // Largest gap (from preferred down to floor) at which every mailbox's block fits in the day.
  let gapUsed = preferred;
  if (perMailbox > 0) {
    while (gapUsed > floor && n * perMailbox * gapUsed + (n - 1) * brk > day) gapUsed -= 1;
  }
  const fits = perMailbox === 0 || (available > 0 && n * perMailbox * gapUsed + (n - 1) * brk <= day);
  const maxSends = available > 0 ? n * Math.floor(available / n / floor) : 0;

  if (!fits) return { windows: [], perMailbox, feasible: false, gapUsed: floor, maxSends };
  return { windows: perMailbox === 0 ? [] : layout(gapUsed), perMailbox, feasible: true, gapUsed, maxSends };
}

/** Default outreach window when a client has not chosen one: 08:00 to 24:00 local time (the whole day). */
/** True when `nowMinute` (minutes since local midnight) is inside the window; windows may cross midnight. */
export function withinSendWindow(window: SendWindow, nowMinute: number): boolean {
  const length = window.endMin - window.startMin;
  const rel = (((nowMinute - window.startMin) % 1440) + 1440) % 1440;
  return rel < length;
}

export const DEFAULT_SEND_WINDOW: SendWindow = { startMin: 8 * 60, endMin: 24 * 60 };

/** Mailbox blocks are separated by this much break by default (the agreed 1 hour). */
export const DEFAULT_BLOCK_BREAK_MINUTES = 60;

/** "HH:MM" or "HH:MM:SS" to minutes after midnight; null when malformed. */
export function parseClockMinutes(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The client's own window from the two clients columns. An end earlier than the start means the window runs past
 * midnight (e.g. 10:00 to 02:00 is 16 hours). Equal, missing or malformed values fall back to the default window.
 * The result is always 5 minutes to 24 hours long.
 */
export function resolveSendWindow(start: unknown, end: unknown): SendWindow {
  const s = parseClockMinutes(start);
  const e0 = parseClockMinutes(end);
  if (s === null || e0 === null || e0 === s) return DEFAULT_SEND_WINDOW;
  const e = e0 > s ? e0 : e0 + 24 * 60;
  if (e - s < 5 || e - s > 24 * 60) return DEFAULT_SEND_WINDOW;
  return { startMin: s, endMin: e };
}

/**
 * True when a window HAS been configured (either end set) but cannot be used: unreadable times, shorter than 5
 * minutes or longer than 24 hours. Sending must then stay closed, not silently fall back to the default window,
 * because the owner meant to restrict sending and a typo must never widen it. An unset window (both ends empty)
 * is not broken: it simply uses the default.
 */
export function isSendWindowBroken(start: unknown, end: unknown): boolean {
  const set = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!set(start) && !set(end)) return false;
  const s = parseClockMinutes(start);
  const e0 = parseClockMinutes(end);
  if (s === null || e0 === null) return true;
  if (e0 === s) return false; // historic behaviour: same start and end means default
  const e = e0 > s ? e0 : e0 + 24 * 60;
  return e - s < 5 || e - s > 24 * 60;
}

/** The cron that drives sending runs every 5 minutes, so a planned gap is rounded down to that grid (never below 5). */
export const TICK_MINUTES = 5;

/**
 * The mailbox blocks for a window: one block per mailbox, sized to its share of the daily total. The gap between sends
 * is aligned to the 5-minute cron tick, so the planned spacing is the real spacing.
 */
export function planBlocks(window: SendWindow, mailboxCount: number, dailyTotal: number): DynamicPlan {
  const base = { total: dailyTotal, mailboxCount, startMin: window.startMin, endMin: window.endMin, breakMinutes: DEFAULT_BLOCK_BREAK_MINUTES };
  const plan = buildDynamicPlan(base);
  if (!plan.feasible || plan.perMailbox === 0) return plan;
  const aligned = Math.max(TICK_MINUTES, Math.floor(plan.gapUsed / TICK_MINUTES) * TICK_MINUTES);
  if (aligned === plan.gapUsed) return plan;
  return buildDynamicPlan({ ...base, gapMinutes: aligned, floorGapMinutes: aligned });
}

/**
 * Which mailbox owns the moment `nowMinute` (local clock). Returns the mailbox index, or -1 when it is a break or
 * outside the window. Works across midnight because positions are measured from the window start.
 */
export function activeBlockIndex(plan: DynamicPlan, window: SendWindow, nowMinute: number): number {
  const length = window.endMin - window.startMin;
  const rel = (((nowMinute - window.startMin) % 1440) + 1440) % 1440;
  if (rel >= length) return -1;
  for (let i = 0; i < plan.windows.length; i++) {
    const b = plan.windows[i];
    const bStart = b.startMin - window.startMin;
    const bEnd = b.endMin - window.startMin;
    if (rel >= bStart && rel < bEnd) return i;
  }
  return -1;
}
