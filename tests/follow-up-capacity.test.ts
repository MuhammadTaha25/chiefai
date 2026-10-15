import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpsPinnedTo, newEmailFits, originalMailboxByLead } from "../src/lib/follow-up-capacity.ts";
import { describeMailboxLimit, effectiveDailyLimit, WARMUP_CAP } from "../src/lib/warmup-schedule.ts";

const DAY = 86400000;
const now = Date.UTC(2026, 9, 15, 12, 0, 0);
const createdDaysAgo = (d: number) => new Date(now - d * DAY).toISOString();

test("a lead's original mailbox is the one that sent its FIRST email", () => {
  const first = originalMailboxByLead([
    { lead_id: "a", mailbox_id: "m1" },
    { lead_id: "a", mailbox_id: "m2" }, // later send from another mailbox never changes the original
    { lead_id: "b", mailbox_id: "m2" },
    { lead_id: "c", mailbox_id: null },
  ]);
  assert.equal(first.get("a"), "m1");
  assert.equal(first.get("b"), "m2");
  assert.equal(first.has("c"), false);
});

test("only follow-ups pinned to THIS mailbox are counted", () => {
  const first = new Map([["a", "m1"], ["b", "m1"], ["c", "m2"]]);
  assert.equal(followUpsPinnedTo(["a", "b", "c", "zz"], first, "m1"), 2);
  assert.equal(followUpsPinnedTo(["a", "b", "c"], first, "m2"), 1);
  assert.equal(followUpsPinnedTo([], first, "m1"), 0);
});

test("new first emails leave room for the follow-ups still due", () => {
  // limit 3, nothing sent, one follow-up waiting: two new emails fit, the third does not
  assert.equal(newEmailFits(0, 1, 3), true);
  assert.equal(newEmailFits(1, 1, 3), true);
  assert.equal(newEmailFits(2, 1, 3), false);
  // no follow-ups waiting: the whole limit is available
  assert.equal(newEmailFits(2, 0, 3), true);
  assert.equal(newEmailFits(3, 0, 3), false);
  // more follow-ups waiting than room: no new emails, follow-ups go first
  assert.equal(newEmailFits(0, 5, 3), false);
});

test("a 6-day-old mailbox saved at 3 a day is held by the saved limit, not by warm-up", () => {
  const d = describeMailboxLimit({ daily_send_limit: 3, created_at: createdDaysAgo(6) }, now);
  assert.equal(d.stageDay, 7);
  assert.equal(d.configured, 3);
  assert.equal(d.effective, 3);
  assert.equal(d.limitedBy, "configured");
  assert.ok(d.warmupAllows > 3);
  assert.equal(d.warmedUp, false);
  assert.ok(d.daysUntilWarmed > 0);
});

test("a 6-day-old mailbox saved at 30 a day is held by the warm-up ceiling", () => {
  const d = describeMailboxLimit({ daily_send_limit: 30, created_at: createdDaysAgo(6) }, now);
  assert.equal(d.limitedBy, "warm-up");
  assert.equal(d.effective, d.warmupAllows);
  assert.ok(d.effective < 30);
});

test("a fully warmed mailbox is not held back, unless an operator set a higher cap", () => {
  const a = describeMailboxLimit({ daily_send_limit: 10, created_at: createdDaysAgo(60) }, now);
  assert.equal(a.warmedUp, true);
  assert.equal(a.daysUntilWarmed, 0);
  assert.equal(a.limitedBy, "none");
  assert.equal(a.effective, WARMUP_CAP);
  const b = describeMailboxLimit({ daily_send_limit: 50, created_at: createdDaysAgo(60) }, now);
  assert.equal(b.limitedBy, "configured");
  assert.equal(b.effective, 50);
});

test("the displayed limit is always the limit sending uses", () => {
  for (const age of [0, 1, 6, 14, 27, 60]) {
    for (const configured of [0, 3, 15, 30, 50]) {
      const m = { daily_send_limit: configured, created_at: createdDaysAgo(age) };
      assert.equal(describeMailboxLimit(m, now).effective, effectiveDailyLimit(m, now, true), `age ${age}, saved ${configured}`);
    }
  }
});
