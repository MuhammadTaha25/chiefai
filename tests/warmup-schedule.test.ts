import { test } from "node:test";
import assert from "node:assert/strict";
import { coldLimitForAge, effectiveDailyLimit, WARMUP_CAP } from "../src/lib/warmup-schedule.ts";

const DAY = 86400000;
// Age in whole days: one hour short of a full day ago is age N when computed with floor (see effectiveDailyLimit).
const created = (ageDays: number, now: number) => new Date(now - ageDays * DAY - 3600000).toISOString();

test("warm-up schedule: smooth exponential ramp from 4/day, never decreasing, capped at 30", () => {
  // V(d) = min(30, floor(4 + 46 * (1 - e^(-d/30)))). Values below are what that formula yields.
  const expected: Record<number, number> = { 0: 4, 1: 5, 3: 8, 5: 11, 7: 13, 10: 17, 14: 21, 21: 27, 27: 30, 28: 30, 400: 30 };
  for (const [day, limit] of Object.entries(expected)) assert.equal(coldLimitForAge(Number(day)), limit, `day ${day}`);
  let prev = 0;
  for (let d = 0; d <= 60; d++) {
    const v = coldLimitForAge(d);
    assert.ok(v >= prev, `never drops (day ${d})`);
    assert.ok(v <= WARMUP_CAP, `never above the cap (day ${d})`);
    prev = v;
  }
  assert.equal(coldLimitForAge(-5), 4, "a negative age is treated as day 0");
});

test("effectiveDailyLimit: during warm-up the age curve is a CEILING and a lower saved limit still applies", () => {
  const now = Date.UTC(2026, 9, 12);
  // new mailbox: saved 30 is held to the curve
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: created(0, now) }, now), 4);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: created(7, now) }, now), 13);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: created(14, now) }, now), 21);
  // saved limit lower than the curve wins (the 3/3 case)
  assert.equal(effectiveDailyLimit({ daily_send_limit: 3, created_at: created(6, now) }, now), 3);
  // not set (null/0): the curve alone decides
  assert.equal(effectiveDailyLimit({ daily_send_limit: null, created_at: created(7, now) }, now), 13);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 0, created_at: created(0, now) }, now), 4);
  // unknown age counts as brand new
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: null }, now), 4);
});

test("effectiveDailyLimit: once fully warmed the limit is at least 30, and an operator may go higher", () => {
  const now = Date.UTC(2026, 9, 12);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 40, created_at: created(60, now) }, now), 40);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 10, created_at: created(60, now) }, now), 30, "a lower saved limit does NOT cap a mature mailbox");
  assert.equal(effectiveDailyLimit({ daily_send_limit: 0, created_at: created(60, now) }, now), 30);
});

test("effectiveDailyLimit: an unhealthy mailbox does not graduate (min of saved limit and the curve)", () => {
  const now = Date.UTC(2026, 9, 12);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 40, created_at: created(60, now) }, now, false), 30);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 10, created_at: created(60, now) }, now, false), 10);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: created(7, now) }, now, false), 13);
});
