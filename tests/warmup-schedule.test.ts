import { test } from "node:test";
import assert from "node:assert/strict";
import { coldLimitForAge, effectiveDailyLimit, WARMUP_CAP } from "../src/lib/warmup-schedule.ts";

const DAY = 86400000;
// Age in whole days: one hour short of a full day ago is age N when computed with floor (see effectiveDailyLimit).
const created = (ageDays: number, now: number) => new Date(now - ageDays * DAY - 3600000).toISOString();

test("warm-up schedule: small cold volume that steps up each week, capped at 30", () => {
  assert.equal(coldLimitForAge(0), 5);
  assert.equal(coldLimitForAge(6), 5);
  assert.equal(coldLimitForAge(7), 10);
  assert.equal(coldLimitForAge(13), 10);
  assert.equal(coldLimitForAge(14), 15);
  assert.equal(coldLimitForAge(21), 25);
  assert.equal(coldLimitForAge(27), 25);
  assert.equal(coldLimitForAge(28), WARMUP_CAP);
  assert.equal(coldLimitForAge(400), WARMUP_CAP);
});

test("effectiveDailyLimit: a new mailbox starts small (5/day) and steps up with its age", () => {
  const now = Date.UTC(2026, 9, 12);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 4, created_at: created(0, now) }, now), 5);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 4, created_at: created(7, now) }, now), 10);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 4, created_at: created(14, now) }, now), 15);
});

test("effectiveDailyLimit: the configured daily limit stays a floor (no regression for mature mailboxes)", () => {
  const now = Date.UTC(2026, 9, 12);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 40, created_at: created(60, now) }, now), 40);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 10, created_at: created(60, now) }, now), 30);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 0, created_at: created(60, now) }, now), 0);
});
