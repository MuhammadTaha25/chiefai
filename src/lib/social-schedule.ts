/**
 * Weekly posting schedule, derived from the automation settings the client
 * chose in the wizard (feed posts per week, how many of them are videos,
 * stories per week, optional preferred time). Pure functions, no I/O.
 *
 * Rules:
 *  - N feed posts a week are spread evenly across Mon..Sun, so anything under
 *    7 leaves rest days (6 → Sunday off, 3 → Mon/Wed/Fri). More than 7 puts
 *    extra posts on some days, spaced six hours apart.
 *  - V of those posts are videos, spread evenly among the N (never bunched).
 *  - Stories are spread the same way and default to two hours after the post
 *    time, so a story lands after the feed post it teases.
 *  - Times are optional. Without a preferred time, posts go out at 17:00 and
 *    stories at 19:00 (in the client's timezone).
 */

export const DEFAULT_POST_TIME = "17:00";
const STORY_OFFSET_MIN = 120;
const SLOT_GAP_MIN = 360;
const LAST_MINUTE_OF_SLOTS = 23 * 60 + 30;

export interface ScheduleInput {
  images: number;
  carousels: number;
  videos: number;
  stories: number;
  /** Used only when none of the per-format counts are set. */
  postsPerWeek?: number | null;
  /** "HH:MM" local time the owner prefers for feed posts; empty = default. */
  postTime?: string | null;
}

export interface PlannedItem {
  kind: "post" | "story";
  format: "image" | "video" | "story";
  /** Monday = 0 … Sunday = 6. */
  weekday: number;
  /** Nth item of the day (0-based). */
  slot: number;
  /** Minutes after local midnight. */
  minutes: number;
}

/** "17:30" → 1050. Anything that is not a valid 24h time → null. */
export function parseTime(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

const clampSlot = (minutes: number) => Math.min(minutes, LAST_MINUTE_OF_SLOTS);

function spreadDays(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.floor((i * 7) / n));
}

export function weeklyItems(input: ScheduleInput): PlannedItem[] {
  const counts = Math.max(0, input.images) + Math.max(0, input.carousels) + Math.max(0, input.videos);
  const feed = Math.min(counts > 0 ? counts : Math.max(0, input.postsPerWeek ?? 0), 21);
  const videos = Math.min(Math.max(0, input.videos), feed);
  const stories = Math.min(Math.max(0, input.stories), 21);
  const postBase = parseTime(input.postTime) ?? parseTime(DEFAULT_POST_TIME)!;
  const storyBase = postBase + STORY_OFFSET_MIN;

  const items: PlannedItem[] = [];

  const videoIdx = new Set(Array.from({ length: videos }, (_, j) => Math.floor(((j + 0.5) * feed) / videos)));
  const seenFeed = new Map<number, number>();
  spreadDays(feed).forEach((weekday, i) => {
    const slot = seenFeed.get(weekday) ?? 0;
    seenFeed.set(weekday, slot + 1);
    items.push({ kind: "post", format: videoIdx.has(i) ? "video" : "image", weekday, slot, minutes: clampSlot(postBase + slot * SLOT_GAP_MIN) });
  });

  const seenStory = new Map<number, number>();
  spreadDays(stories).forEach((weekday) => {
    const slot = seenStory.get(weekday) ?? 0;
    seenStory.set(weekday, slot + 1);
    items.push({ kind: "story", format: "story", weekday, slot, minutes: clampSlot(storyBase + slot * SLOT_GAP_MIN) });
  });

  return items;
}

/** Items of `kind` planned for today whose time has already arrived (the caller skips ones it already generated). */
export function dueItems(input: ScheduleInput, local: { weekday: number; minutes: number }, kind: "post" | "story"): PlannedItem[] {
  return weeklyItems(input).filter((it) => it.kind === kind && it.weekday === local.weekday && it.minutes <= local.minutes);
}

/** Local weekday (Mon=0), minutes since midnight and ISO date in `timeZone`; `at` ("YYYY-MM-DDTHH:mm") overrides the clock for testing. */
export function localClock(timeZone: string, now = new Date(), at?: string | null): { date: string; weekday: number; minutes: number } {
  const m = at ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(at) : null;
  if (m) {
    const d = new Date(`${m[1]}T00:00:00Z`);
    return { date: m[1], weekday: (d.getUTCDay() + 6) % 7, minutes: Number(m[2]) * 60 + Number(m[3]) };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const slotKey = (kind: "post" | "story", date: string, slot: number) => `auto_${kind}_${date}_${slot}`;
