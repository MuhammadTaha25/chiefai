import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOMMENDED_PLAN, weeklyItems } from "../src/lib/social-schedule.ts";

test("recommended plan lands on Tue, Wed, Thu at 12:00 with stories at 20:00", () => {
  const items = weeklyItems({
    images: RECOMMENDED_PLAN.images,
    carousels: RECOMMENDED_PLAN.carousels,
    videos: RECOMMENDED_PLAN.videos,
    stories: RECOMMENDED_PLAN.stories,
    postTime: RECOMMENDED_PLAN.postTime,
    storyTime: RECOMMENDED_PLAN.storyTime,
    days: [...RECOMMENDED_PLAN.days],
  });
  const posts = items.filter((i) => i.kind === "post");
  const stories = items.filter((i) => i.kind === "story");
  assert.deepEqual(posts.map((p) => p.weekday), [1, 2, 3]);
  assert.ok(posts.every((p) => p.minutes === 12 * 60));
  assert.deepEqual(stories.map((s) => s.weekday), [1, 2, 3]);
  assert.ok(stories.every((s) => s.minutes === 20 * 60));
  assert.equal(posts.filter((p) => p.format === "video").length, 1);
});

test("without chosen days, posts still spread across the week (old behaviour)", () => {
  const items = weeklyItems({ images: 0, carousels: 0, videos: 0, stories: 0, postsPerWeek: 3 });
  assert.deepEqual(items.map((i) => i.weekday), [0, 2, 4]);
});

test("story time defaults to two hours after the post time when not set", () => {
  const items = weeklyItems({ images: 1, carousels: 0, videos: 0, stories: 1, postTime: "10:00", days: [0] });
  assert.equal(items.find((i) => i.kind === "story")?.minutes, 12 * 60);
});

import { DAILY_WEEKLY_PLAN, dueFromItems, parseWeeklyPlan, planItems, countsFromPlan, RECOMMENDED_WEEKLY_PLAN } from "../src/lib/social-schedule.ts";

test("per-day plan: recommended gives image Tue, carousel Wed, video Thu, stories 8 PM", () => {
  const items = planItems(RECOMMENDED_WEEKLY_PLAN, "12:00", "20:00");
  const posts = items.filter((i) => i.kind === "post");
  assert.deepEqual(posts.map((p) => [p.weekday, p.format]), [[1, "image"], [2, "carousel"], [3, "video"]]);
  assert.ok(items.filter((i) => i.kind === "story").every((s) => s.minutes === 20 * 60));
  assert.deepEqual(countsFromPlan(RECOMMENDED_WEEKLY_PLAN), { posts: 3, images: 1, carousels: 1, videos: 1, stories: 3 });
});

test("per-day plan: daily gives 7 posts and 7 stories", () => {
  const c = countsFromPlan(DAILY_WEEKLY_PLAN);
  assert.equal(c.posts, 7);
  assert.equal(c.stories, 7);
});

test("per-day plan: due check only fires on the planned day and time", () => {
  const items = planItems(RECOMMENDED_WEEKLY_PLAN, "12:00", "20:00");
  assert.equal(dueFromItems(items, { weekday: 2, minutes: 12 * 60 + 5 }, "post")[0]?.format, "carousel");
  assert.equal(dueFromItems(items, { weekday: 0, minutes: 23 * 60 }, "post").length, 0);
});

test("parseWeeklyPlan rejects bad input", () => {
  assert.equal(parseWeeklyPlan(null), null);
  assert.equal(parseWeeklyPlan([{ post: "text", story: false }, ...Array(6).fill({ post: "none", story: false })]), null);
  assert.equal(parseWeeklyPlan(Array(6).fill({ post: "none", story: false })), null);
  assert.ok(parseWeeklyPlan(RECOMMENDED_WEEKLY_PLAN));
});
