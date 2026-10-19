import test from "node:test";
import assert from "node:assert/strict";
import { seededUnit, followUpGapMs, plannedGapMs } from "../src/lib/send-jitter.ts";

test("same seed gives the same gap (stable while waiting)", () => {
  assert.equal(followUpGapMs("2026-10-19T10:00:00Z"), followUpGapMs("2026-10-19T10:00:00Z"));
  assert.equal(seededUnit("a"), seededUnit("a"));
});

test("follow-up gaps stay within 3-10 minutes and actually vary", () => {
  const set = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const g = followUpGapMs(`seed-${i}`);
    assert.ok(g >= 3 * 60_000 && g <= 10 * 60_000, String(g));
    set.add(Math.round(g / 60_000));
  }
  assert.ok(set.size >= 5, "gaps should differ");
});

test("first-email gaps never exceed the plan or drop below the 5-minute floor", () => {
  const set = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const g = plannedGapMs(15, `seed-${i}`);
    assert.ok(g >= 9 * 60_000 - 1 && g <= 15 * 60_000, String(g));
    set.add(Math.round(g / 60_000));
  }
  assert.ok(set.size >= 4);
  assert.equal(plannedGapMs(5, "x"), 5 * 60_000);
});
