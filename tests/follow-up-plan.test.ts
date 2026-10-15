import { test } from "node:test";
import assert from "node:assert/strict";
import { planFollowUp, resolveFirstFollowUpDelayMs, resolveFollowUpIntervalMs } from "../src/lib/follow-up-config.ts";

// Simulates the cron over one lead's whole life. The initial email sets follow_up_number to 1 (every send path does).
function runSequence(maxFollowUps: number) {
  let stored = 1;
  const sent: { followUpIndex: number; touchNumber: number; status: string; storedAfter: number; scheduledNext: boolean }[] = [];
  for (let run = 0; run < 20; run++) {
    const plan = planFollowUp(stored, maxFollowUps);
    if (plan.capped) break;
    sent.push({ followUpIndex: plan.followUpIndex, touchNumber: plan.nextFollowUpNumber, status: plan.status, storedAfter: plan.nextFollowUpNumber, scheduledNext: !plan.isLast });
    stored = plan.nextFollowUpNumber;
    if (plan.isLast) break;
  }
  return sent;
}

test("'3 follow-ups' sends exactly 3 follow-ups after the initial email (not 2)", () => {
  const sent = runSequence(3);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.followUpIndex), [1, 2, 3]);
});

test("touch numbers continue from the initial email (touch 1) with no gap: 2, 3, 4", () => {
  assert.deepEqual(runSequence(3).map((s) => s.touchNumber), [2, 3, 4]);
});

test("status means 'follow-ups sent' (follow_up_1..3), matching the manual send route", () => {
  assert.deepEqual(runSequence(3).map((s) => s.status), ["follow_up_1", "follow_up_2", "follow_up_3"]);
});

test("only the last allowed follow-up schedules nothing further", () => {
  assert.deepEqual(runSequence(3).map((s) => s.scheduledNext), [true, true, false]);
});

test("smaller client allowances are honoured: 0, 1 and 2 follow-ups", () => {
  assert.equal(runSequence(0).length, 0);
  assert.equal(runSequence(1).length, 1);
  assert.equal(runSequence(2).length, 2);
});

test("a lead already past the cap is capped, never sent to", () => {
  // initial + 3 follow-ups => stored 4
  assert.equal(planFollowUp(4, 3).capped, true);
  assert.equal(planFollowUp(3, 3).capped, false);
  assert.equal(planFollowUp(1, 0).capped, true);
});

test("the stored follow_up_number advances by exactly one per send", () => {
  assert.deepEqual(runSequence(3).map((s) => s.storedAfter), [2, 3, 4]);
});

test("status never exceeds follow_up_10", () => {
  assert.equal(planFollowUp(50, 99).status, "follow_up_10");
});

test("follow-up delay: client setting wins inside the allowed range, otherwise the 3-day default", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1, `${actual} is not within 1 ms of ${expected}`);
  near(resolveFirstFollowUpDelayMs({ follow_up_delay_days: 0.042 }), 0.042 * DAY);
  near(resolveFollowUpIntervalMs({ follow_up_delay_days: "0.01" }), 0.01 * DAY);
  near(resolveFollowUpIntervalMs({ follow_up_delay_days: 0 }), 3 * DAY); // below the floor -> default
  near(resolveFollowUpIntervalMs({ follow_up_delay_days: 999 }), 3 * DAY); // above the ceiling -> default
  near(resolveFollowUpIntervalMs(null), 3 * DAY);
});

test("the first follow-up delay and later intervals always agree", () => {
  for (const c of [null, {}, { follow_up_delay_days: 0.5 }, { follow_up_delay_days: "x" }]) {
    assert.equal(resolveFirstFollowUpDelayMs(c as Record<string, unknown> | null), resolveFollowUpIntervalMs(c as Record<string, unknown> | null));
  }
});
