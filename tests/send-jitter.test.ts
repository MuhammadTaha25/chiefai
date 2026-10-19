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
    assert.ok(g >= 5 * 60_000 && g <= 15 * 60_000, String(g));
    set.add(Math.round(g / 60_000));
  }
  assert.ok(set.size >= 6);
  assert.equal(plannedGapMs(5, "x"), 5 * 60_000);
});

test("a tick that fires a few seconds early still counts (4:54 elapsed satisfies a 5:00 gap), but 3 minutes does not", async () => {
  const { stillWaiting } = await import("../src/lib/send-jitter.ts");
  const last = "2026-10-19T10:00:00.000Z";
  assert.equal(stillWaiting(last, 5 * 60_000, Date.parse(last) + 4 * 60_000 + 54_000), false);
  assert.equal(stillWaiting(last, 5 * 60_000, Date.parse(last) + 3 * 60_000), true);
});
