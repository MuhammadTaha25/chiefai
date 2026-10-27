import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRUST_MECHANISMS,
  conversionCap,
  painPointList,
  entryKey,
  mergeWeek,
  parseWeekEntries,
  planWeekSkeleton,
  validateWeekDrafts,
  weekStartOf,
  weeksToPlan,
} from "../src/lib/week-plan.ts";
import { planItems, RECOMMENDED_PLAN } from "../src/lib/social-schedule.ts";
import type { BusinessContext } from "../src/lib/business-context.ts";

const ctx: BusinessContext = {
  clientId: "c1",
  businessName: "Harbor Realty",
  primaryGoal: "lead_generation",
  targetAudience: ["home sellers", "first-time buyers"],
  services: "residential sales",
  painPoints: "Missed showing calls; slow replies to buyers; manual paperwork. Unanswered listing questions.",
  products: [{ name: "Home valuation" }, { name: "Buyer consultation" }, { name: "Staging advice" }],
};

// Mon image, Tue video, Wed carousel, Thu image, Fri video, Sat carousel, Sun image (the real client's plan)
const week = planItems(
  [
    { post: "image", story: true },
    { post: "video", story: true },
    { post: "carousel", story: true },
    { post: "image", story: true },
    { post: "video", story: true },
    { post: "carousel", story: true },
    { post: "image", story: true },
  ],
  "00:00",
  "00:30",
);

test("weekStartOf finds the Monday, and weeksToPlan adds next week only from Sunday 20:00", () => {
  assert.equal(weekStartOf("2026-10-27", 1), "2026-10-26"); // Tuesday
  assert.equal(weekStartOf("2026-10-26", 0), "2026-10-26"); // Monday itself
  assert.equal(weekStartOf("2026-11-01", 6), "2026-10-26"); // Sunday belongs to the week that started Monday
  assert.deepEqual(weeksToPlan({ date: "2026-10-27", weekday: 1, minutes: 600 }), ["2026-10-26"]);
  assert.deepEqual(weeksToPlan({ date: "2026-11-01", weekday: 6, minutes: 19 * 60 + 59 }), ["2026-10-26"]);
  assert.deepEqual(weeksToPlan({ date: "2026-11-01", weekday: 6, minutes: 20 * 60 }), ["2026-10-26", "2026-11-02"]);
});

test("skeleton: one entry per feed post (not stories), keyed by weekday and slot", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  assert.equal(sk.length, 7);
  assert.deepEqual(sk.map((s) => s.key), [0, 1, 2, 3, 4, 5, 6].map((d) => entryKey(d, 0)));
  assert.deepEqual(sk.map((s) => s.format), ["image", "video", "carousel", "image", "video", "carousel", "image"]);
});

test("skeleton: never the same pillar twice in a row, at most one offer post a week, products rotate", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  for (let i = 1; i < sk.length; i++) assert.notEqual(sk[i].pillar, sk[i - 1].pillar);
  assert.ok(sk.filter((s) => s.pillar === "conversion").length <= conversionCap(7));
  assert.equal(conversionCap(7), 1);
  assert.equal(conversionCap(2), 0);
  assert.ok(new Set(sk.map((s) => s.productName)).size >= 3, "all three products appear across the week");
  assert.ok(sk.every((s) => s.cta.length > 0));
});

test("skeleton: continues from recent history (does not open with the pillar just used)", () => {
  const sk = planWeekSkeleton(ctx, [{ content_pillar: "educational", topic: "a", hook: "b" }], week);
  assert.notEqual(sk[0].pillar, "educational");
});

const good = (sk: ReturnType<typeof planWeekSkeleton>) =>
  sk.map((s, i) => ({
    key: s.key,
    topic: ["Seller doubts about listing price", "Open house nobody visited", "Staging a small living room", "Why offers fall through at closing", "A buyer missing a call during a showing", "Mortgage letter versus cash offer", "Neighbours reading a sold sign"][i],
    hook: (s.pillar === "conversion" ? "Book a free look at your closing process" : ["Your listing price is not the price buyers see", "Nobody came to the open house?", "Three chairs can make a room feel bigger", "Closing day, and the buyer vanishes", "Missed the showing call again", "Cash or letter: which wins your sale", "A sold sign changes how the street talks"][i]),
    visualIdea: [
      "A seller reading a price sticker on a living room window",
      "A realtor in an empty garden holding open-house signs in the rain",
      "A stylist rearranging three armchairs in a small bright room",
      "A lawyer stacking signed folders on a long table",
      "A buyer waiting beside a locked showing door with a key box",
      "A banker sliding two envelopes across a counter",
      "A street of houses with a red sold sign in one front yard",
    ][i],
    angle: ["checklist", "demonstration", "misconception", "comparison", "decision_guide", "objection", "moment_story"][i],
  }));

test("validation accepts a clean, varied week and merges it", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const drafts = good(sk);
  assert.equal(validateWeekDrafts(sk, drafts, []), null);
  const merged = mergeWeek(sk, drafts);
  assert.equal(merged.length, 7);
  assert.equal(merged[0].topic, drafts[0].topic);
  assert.equal(parseWeekEntries(JSON.parse(JSON.stringify(merged))).length, 7);
});

test("validation rejects: missing entry, abstract visual idea, repeated topic, same opening words, repeat of recent post", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const base = good(sk);

  assert.match(validateWeekDrafts(sk, base.slice(1), [])!, /no entry/);

  const abstract = base.map((d, i) => (i === 2 ? { ...d, visualIdea: "The impact of slow response on productivity across the team" } : d));
  assert.match(validateWeekDrafts(sk, abstract, [])!, /not something that can be seen/);

  const dup = base.map((d, i) => (i === 3 ? { ...d, topic: base[0].topic } : d));
  assert.match(validateWeekDrafts(sk, dup, [])!, /same topic/);

  const sameOpen = base.map((d, i) => (i === 4 ? { ...d, hook: "Your listing price is wrong sometimes" } : d));
  assert.match(validateWeekDrafts(sk, sameOpen, [])!, /(same hook|open with the same words)/);

  assert.match(validateWeekDrafts(sk, base, [{ topic: base[5].topic, hook: "x y z" }])!, /repeats/);

  const short = base.map((d, i) => (i === 0 ? { ...d, visualIdea: "A phone" } : d));
  assert.match(validateWeekDrafts(sk, short, [])!, /too short/);
});

test("parseWeekEntries drops malformed rows instead of throwing", () => {
  assert.deepEqual(parseWeekEntries(null), []);
  assert.deepEqual(parseWeekEntries([{ key: "0:0" }, 5, null, { key: "1:0", topic: "t", hook: "h", visualIdea: "v", pillar: "nope", cta: "c", format: "image" }]), []);
  assert.equal(
    parseWeekEntries([{ key: "1:0", topic: "t", hook: "h", visualIdea: "v", pillar: "educational", cta: "c", format: "video", weekday: 1, slot: 0 }]).length,
    1,
  );
});

test("the recommended plan constant still exists (guards the import used elsewhere)", () => {
  assert.ok(RECOMMENDED_PLAN.days.length > 0);
});

test("pain points: the business's list is split into single problems", () => {
  assert.deepEqual(painPointList("Too many repetitive customer questions; missed calls; slow lead follow-up; manual repetitive work."), [
    "Too many repetitive customer questions",
    "missed calls",
    "slow lead follow-up",
    "manual repetitive work",
  ]);
  assert.deepEqual(painPointList(undefined), []);
});

test("skeleton: every post gets a problem, and neighbouring posts never share one", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  assert.ok(sk.every((s) => s.painPoint));
  for (let i = 1; i < sk.length; i++) assert.notEqual(sk[i].painPoint, sk[i - 1].painPoint);
  assert.ok(new Set(sk.map((s) => s.painPoint)).size >= 4, "all four problems are used");
});

test("validation rejects a stock-photo visual, but accepts the same props when something is happening", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const base = good(sk);
  const stock = base.map((d, i) => (i === 1 ? { ...d, visualIdea: "An agency manager sitting at a desk with a laptop and a coffee" } : d));
  assert.match(validateWeekDrafts(sk, stock, [])!, /stock-photo/);
  const happening = base.map((d, i) => (i === 1 ? { ...d, visualIdea: "An agent at a desk with a laptop while the phone beside it keeps ringing unanswered" } : d));
  assert.equal(validateWeekDrafts(sk, happening, []), null);
});

test("validation rejects a hook that introduces the company or uses a tool name", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const base = good(sk);
  const company = base.map((d, i) => (i === 3 ? { ...d, hook: "We build done-for-you automations that save hours" } : d));
  assert.match(validateWeekDrafts(sk, company, [])!, /introduces the company/);
  const jargon = base.map((d, i) => (i === 5 ? { ...d, hook: "Connect your tools with custom n8n flows built for you" } : d));
  assert.match(validateWeekDrafts(sk, jargon, [])!, /jargon/);
});

test("validation rejects: result numbers, feature hooks, solved-state visuals, repeated angle, missing angle", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const base = good(sk);
  const at = (i: number, patch: object) => base.map((d, j) => (j === i ? { ...d, ...patch } : d));

  assert.match(validateWeekDrafts(sk, at(1, { hook: "Reclaim ten hours of work every week" }), [])!, /number of hours/);
  assert.match(validateWeekDrafts(sk, at(1, { hook: "Cut costs by 40% this month" }), [])!, /number of hours|percentage/);
  assert.equal(validateWeekDrafts(sk, at(1, { hook: "Five buyers asked the same question today" }), []), null, "a plain count of people is not a result claim");
  assert.match(validateWeekDrafts(sk, at(1, { hook: "You can automatically answer every missed call" }), [])!, /announces a feature/);
  assert.match(validateWeekDrafts(sk, at(1, { angle: undefined }), [])!, /needs an angle/);
  assert.match(validateWeekDrafts(sk, at(1, { angle: "inspiration" }), [])!, /needs an angle/);
  assert.match(validateWeekDrafts(sk, at(2, { angle: base[0].angle }), [])!, /same angle/);
  const problem = sk.findIndex((s) => s.pillar !== "solution" && s.pillar !== "conversion");
  assert.match(validateWeekDrafts(sk, at(problem, { visualIdea: "A manager in a doorway pointing at a whiteboard of completed tasks" }), [])!, /finished solution/);
});

test("skeleton: trust posts get a trust mechanism that needs no testimonial; other pillars get none", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  for (const s of sk) {
    if (s.pillar === "trust") assert.ok(TRUST_MECHANISMS.includes(s.trustMechanism as never));
    else assert.equal(s.trustMechanism, undefined);
  }
  assert.ok(!(TRUST_MECHANISMS as readonly string[]).some((m) => /testimonial|case_study/.test(m)));
});

test("validation rejects: too many phone scenes, near-identical pictures, a conversion hook without a next step, 'done-for-you' wording", () => {
  const sk = planWeekSkeleton(ctx, [], week);
  const base = good(sk);
  const phone = (i: number) => ({ visualIdea: `A person ${["pacing", "sitting", "standing", "kneeling", "leaning"][i]} in a hall as a phone rings loudly beside them` });
  const three = base.map((d, i) => (i < 3 ? { ...d, ...phone(i) } : d));
  assert.match(validateWeekDrafts(sk, three, [])!, /same kind of scene/);
  const twin = base.map((d, i) => (i === 5 ? { ...d, visualIdea: base[4].visualIdea } : d));
  assert.match(validateWeekDrafts(sk, twin, [])!, /nearly the same picture/);
  const c = sk.findIndex((s) => s.pillar === "conversion");
  assert.match(validateWeekDrafts(sk, base.map((d, i) => (i === c ? { ...d, hook: "Tired of losing deals every month?" } : d)), [])!, /no next step/);
  assert.match(validateWeekDrafts(sk, base.map((d, i) => (i === 0 ? { ...d, hook: "Try our done-for-you desk for sellers" } : d)), [])!, /jargon|announces/);
});
