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

/**
 * Research-backed starting plan (Sprout Social best-times data, Buffer and
 * Socialinsider format data). Shown to the owner as the recommended option; the
 * owner can change any of it. Not a guarantee of reach.
 */
export const RECOMMENDED_PLAN = {
  postsPerWeek: 3,
  images: 1,
  carousels: 1,
  videos: 1,
  stories: 3,
  days: [1, 2, 3], // Tue, Wed, Thu (Monday = 0)
  postTime: "12:00",
  storyTime: "20:00",
} as const;
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
  /** "HH:MM" local time for stories; empty = two hours after the post time. */
  storyTime?: string | null;
  /** Weekdays the owner chose (Mon=0 … Sun=6). Empty/missing = spread evenly across the week. */
  days?: number[] | null;
}

export interface PlannedItem {
  kind: "post" | "story";
  format: "image" | "carousel" | "video" | "story";
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

/** Weekday for each of n items: spread over the chosen days if any, otherwise over the whole week. */
function pickWeekdays(n: number, days?: number[] | null): number[] {
  const chosen = [...new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (!chosen.length) return spreadDays(n);
  return Array.from({ length: n }, (_, i) => chosen[Math.floor((i * chosen.length) / n)]);
}

export function weeklyItems(input: ScheduleInput): PlannedItem[] {
  const counts = Math.max(0, input.images) + Math.max(0, input.carousels) + Math.max(0, input.videos);
  const feed = Math.min(counts > 0 ? counts : Math.max(0, input.postsPerWeek ?? 0), 21);
  const videos = Math.min(Math.max(0, input.videos), feed);
  const stories = Math.min(Math.max(0, input.stories), 21);
  const postBase = parseTime(input.postTime) ?? parseTime(DEFAULT_POST_TIME)!;
  const storyBase = parseTime(input.storyTime) ?? postBase + STORY_OFFSET_MIN;

  const items: PlannedItem[] = [];

  const videoIdx = new Set(Array.from({ length: videos }, (_, j) => Math.floor(((j + 0.5) * feed) / videos)));
  const seenFeed = new Map<number, number>();
  pickWeekdays(feed, input.days).forEach((weekday, i) => {
    const slot = seenFeed.get(weekday) ?? 0;
    seenFeed.set(weekday, slot + 1);
    items.push({ kind: "post", format: videoIdx.has(i) ? "video" : "image", weekday, slot, minutes: clampSlot(postBase + slot * SLOT_GAP_MIN) });
  });

  const seenStory = new Map<number, number>();
  pickWeekdays(stories, input.days).forEach((weekday) => {
    const slot = seenStory.get(weekday) ?? 0;
    seenStory.set(weekday, slot + 1);
    items.push({ kind: "story", format: "story", weekday, slot, minutes: clampSlot(storyBase + slot * SLOT_GAP_MIN) });
  });

  return items;
}

/**
 * Items of `kind` planned for today whose time has arrived.
 *
 * A slot is "due" when its scheduled minutes ≤ current minutes (i.e. the time
 * has passed) AND it is within `windowMinutes` of its schedule (default 60).
 * The window prevents a cron from firing a slot hours before its scheduled time
 * because of a misconfigured or default fallback time — a 20:00 story must
 * never fire at 17:30 even if the cron mis-computed its slot to 17:21.
 */
export function dueItems(
  input: ScheduleInput,
  local: { weekday: number; minutes: number },
  kind: "post" | "story",
  windowMinutes = 60,
): PlannedItem[] {
  return weeklyItems(input).filter(
    (it) =>
      it.kind === kind &&
      it.weekday === local.weekday &&
      it.minutes <= local.minutes &&
      local.minutes - it.minutes <= windowMinutes,
  );
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

// --- per-day plan -------------------------------------------------------------
// The owner picks, for each weekday, what goes out: a feed post (rest, image,
// carousel or video) and whether there is a story that day. Monday = index 0.

export type PostFormat = "none" | "image" | "carousel" | "video";

export interface DayPlan {
  post: PostFormat;
  story: boolean;
}

/** Seven entries, Mon..Sun. */
export type WeeklyPlan = DayPlan[];

const REST: DayPlan = { post: "none", story: false };

export const RECOMMENDED_WEEKLY_PLAN: WeeklyPlan = [
  REST,
  { post: "image", story: true }, // Tue
  { post: "carousel", story: true }, // Wed
  { post: "video", story: true }, // Thu
  REST,
  REST,
  REST,
];

export const DAILY_WEEKLY_PLAN: WeeklyPlan = [
  { post: "image", story: true },
  { post: "video", story: true },
  { post: "carousel", story: true },
  { post: "image", story: true },
  { post: "video", story: true },
  { post: "carousel", story: true },
  { post: "image", story: true },
];

const POST_FORMATS: PostFormat[] = ["none", "image", "carousel", "video"];

/** Anything that is not a valid 7-day plan → null (the caller falls back to the count-based plan). */
export function parseWeeklyPlan(value: unknown): WeeklyPlan | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const out: WeeklyPlan = [];
  for (const d of value) {
    if (!d || typeof d !== "object") return null;
    const post = (d as { post?: unknown }).post;
    if (typeof post !== "string" || !POST_FORMATS.includes(post as PostFormat)) return null;
    out.push({ post: post as PostFormat, story: Boolean((d as { story?: unknown }).story) });
  }
  return out;
}

/** The per-day plan as planned items, one feed post per day and at most one story per day. */
export function planItems(plan: WeeklyPlan, postTime: string | null | undefined, storyTime: string | null | undefined): PlannedItem[] {
  const postBase = parseTime(postTime) ?? parseTime(DEFAULT_POST_TIME)!;
  const storyBase = parseTime(storyTime) ?? postBase + STORY_OFFSET_MIN;
  const items: PlannedItem[] = [];
  plan.forEach((day, weekday) => {
    if (day.post !== "none") {
      items.push({
        kind: "post",
        format: day.post === "video" ? "video" : day.post === "carousel" ? "carousel" : "image",
        weekday,
        slot: 0,
        minutes: clampSlot(postBase),
      });
    }
    if (day.story) items.push({ kind: "story", format: "story", weekday, slot: 0, minutes: clampSlot(storyBase) });
  });
  return items;
}

/** Feed posts and stories in a planned list that are due now (same rule as dueItems). */
export function dueFromItems(
  items: PlannedItem[],
  local: { weekday: number; minutes: number },
  kind: "post" | "story",
  windowMinutes = 60,
): PlannedItem[] {
  return items.filter(
    (it) =>
      it.kind === kind &&
      it.weekday === local.weekday &&
      it.minutes <= local.minutes &&
      local.minutes - it.minutes <= windowMinutes,
  );
}

/** Counts per format, so the older count columns stay in step with the per-day plan. */
export function countsFromPlan(plan: WeeklyPlan) {
  const posts = plan.filter((d) => d.post !== "none");
  return {
    posts: posts.length,
    images: posts.filter((d) => d.post === "image").length,
    carousels: posts.filter((d) => d.post === "carousel").length,
    videos: posts.filter((d) => d.post === "video").length,
    stories: plan.filter((d) => d.story).length,
  };
}
