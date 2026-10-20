import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOMMENDED_WINDOWS, MIN_GAP_MINUTES, FLOOR_GAP_MINUTES, JITTER_FRACTION, planSendsForDay, shiftWindows, formatMinute, buildDynamicPlan } from "../src/lib/send-window.ts";

test("recommended windows: 08-12, 14-16, 18-20 are the default", () => {
  assert.deepEqual(RECOMMENDED_WINDOWS.map((w) => [formatMinute(w.startMin), formatMinute(w.endMin)]), [["08:00", "12:00"], ["14:00", "16:00"], ["18:00", "20:00"]]);
});

test("changing the start time moves the whole timeline and keeps every window length and break", () => {
  const shifted = shiftWindows(RECOMMENDED_WINDOWS, 9 * 60);
  assert.deepEqual(shifted.map((w) => [formatMinute(w.startMin), formatMinute(w.endMin)]), [["09:00", "13:00"], ["15:00", "17:00"], ["19:00", "21:00"]]);
  assert.equal(shifted[1].startMin - shifted[0].endMin, RECOMMENDED_WINDOWS[1].startMin - RECOMMENDED_WINDOWS[0].endMin);
});

test("one mailbox per window, round-robin, and each window's sends are spaced by at least the minimum gap", () => {
  const plan = planSendsForDay({
    windows: RECOMMENDED_WINDOWS,
    mailboxes: [{ id: "A", remaining: 10 }, { id: "B", remaining: 10 }, { id: "C", remaining: 10 }],
    total: 30,
  });
  // 08-12 holds 16 sends at a 15-min gap, 14-16 and 18-20 hold 8 each.
  assert.equal(plan.length, 26);
  const byMailbox = (id: string) => plan.filter((p) => p.mailboxId === id).length;
  assert.equal(byMailbox("A"), 10);
  assert.equal(byMailbox("B"), 8);
  assert.equal(byMailbox("C"), 8);
  for (let i = 1; i < plan.length; i++) {
    const sameWindow = RECOMMENDED_WINDOWS.some((w) => plan[i].minute >= w.startMin && plan[i - 1].minute >= w.startMin && plan[i].minute < w.endMin && plan[i - 1].minute < w.endMin);
    // Send times are deliberately jittered by up to +-30% of the spacing so they never repeat exactly; two neighbours can
    // therefore end up closer than the nominal gap, but never closer than the nominal gap minus both shifts.
    const worstCase = MIN_GAP_MINUTES - 2 * Math.floor(MIN_GAP_MINUTES * JITTER_FRACTION);
    if (sameWindow) assert.ok(plan[i].minute - plan[i - 1].minute >= Math.max(FLOOR_GAP_MINUTES, worstCase), `gap ${plan[i].minute - plan[i - 1].minute}`);
  }
  assert.ok(plan.every((p) => RECOMMENDED_WINDOWS.some((w) => p.minute >= w.startMin && p.minute < w.endMin)));
});

test("never sends more than a mailbox's remaining capacity, or more than the day's total", () => {
  const plan = planSendsForDay({
    windows: RECOMMENDED_WINDOWS,
    mailboxes: [{ id: "A", remaining: 4 }, { id: "B", remaining: 0 }],
    total: 50,
  });
  assert.equal(plan.filter((p) => p.mailboxId === "A").length, 4);
  assert.equal(plan.filter((p) => p.mailboxId === "B").length, 0);
  assert.ok(plan.length <= 50);
});

test("no mailboxes or zero total: nothing is planned", () => {
  assert.deepEqual(planSendsForDay({ windows: RECOMMENDED_WINDOWS, mailboxes: [], total: 10 }), []);
  assert.deepEqual(planSendsForDay({ windows: RECOMMENDED_WINDOWS, mailboxes: [{ id: "A", remaining: 5 }], total: 0 }), []);
});

test("dynamic plan keeps the claimed 50 per day with 5 mailboxes by lowering the gap to fit (not cutting to 30)", () => {
  const p = buildDynamicPlan({ total: 50, mailboxCount: 5 });
  assert.equal(p.feasible, true);
  assert.equal(p.perMailbox, 10);
  assert.equal(p.windows.length, 5);
  assert.ok(p.gapUsed <= MIN_GAP_MINUTES && p.gapUsed >= FLOOR_GAP_MINUTES);
  const end = p.windows[p.windows.length - 1].endMin;
  assert.ok(end <= 20 * 60, "every block ends by 20:00");
  // every block is exactly as long as its 10 sends need at the chosen gap
  assert.ok(p.windows.every((w) => w.endMin - w.startMin === 10 * p.gapUsed));
});

test("dynamic plan adapts to any mailbox count and total without code changes", () => {
  // 8 mailboxes x 10 with one block per mailbox and 60-min breaks does not fit 08-20 even at the floor gap (LIMIT, reported not hidden).
  const eight = buildDynamicPlan({ total: 80, mailboxCount: 8 });
  assert.equal(eight.perMailbox, 10);
  assert.equal(eight.feasible, false);
  assert.ok(eight.maxSends < 80);
  const one = buildDynamicPlan({ total: 10, mailboxCount: 1 });
  assert.equal(one.feasible, true);
  assert.equal(one.windows.length, 1);
  const grow = buildDynamicPlan({ total: 100, mailboxCount: 10, breakMinutes: 0 });
  assert.equal(grow.perMailbox, 10);
  assert.equal(grow.feasible, true);
});

test("dynamic plan reports infeasible only when even the floor gap cannot fit the total", () => {
  const tooMany = buildDynamicPlan({ total: 400, mailboxCount: 2 });
  assert.equal(tooMany.feasible, false);
  assert.ok(tooMany.maxSends < 400);
});

import { DEFAULT_SEND_WINDOW as DSW, resolveSendWindow as rsw, parseClockMinutes as pcm, planBlocks, activeBlockIndex } from "../src/lib/send-window.ts";

test("client window: valid HH:MM used; overnight allowed; null/malformed/equal fall back to 08:00-24:00", () => {
  assert.deepEqual(rsw("09:00:00", "10:00:00"), { startMin: 540, endMin: 600 });
  assert.deepEqual(rsw("10:00", "02:00"), { startMin: 600, endMin: 1560 });
  assert.deepEqual(rsw(null, null), DSW);
  assert.deepEqual(rsw("abc", "10:00"), DSW);
  assert.deepEqual(rsw("08:00", "08:00"), DSW);
  assert.equal(DSW.endMin - DSW.startMin, 16 * 60);
  assert.equal(pcm("25:00"), null);
});

test("blocks: 5 mailboxes x 10 across 08:00-24:00 with a 1h break fit; gaps sit on the 5-minute cron grid", () => {
  const plan = planBlocks(DSW, 5, 50);
  assert.equal(plan.feasible, true);
  assert.equal(plan.gapUsed, 10);
  assert.equal(plan.windows[0].startMin, 480);
  assert.equal(plan.windows[4].endMin <= 1440, true);
  assert.equal(activeBlockIndex(plan, DSW, 9 * 60), 0);
  assert.equal(activeBlockIndex(plan, DSW, 10 * 60 + 30), -1);
  assert.equal(activeBlockIndex(plan, DSW, 11 * 60 + 30), 1);
});

test("blocks across midnight: a 20:00-08:00 window puts the second block after 00:00", () => {
  const w = rsw("20:00", "08:00");
  const plan = planBlocks(w, 2, 20);
  assert.equal(plan.feasible, true);
  assert.equal(activeBlockIndex(plan, w, 21 * 60), 0);
  assert.equal(activeBlockIndex(plan, w, 30), 1);
  assert.equal(activeBlockIndex(plan, w, 3 * 60), -1);
});

test("50 in 08-12 cannot fit at the 5-minute floor (reported infeasible, most that fits is reported)", () => {
  const plan = planBlocks({ startMin: 480, endMin: 720 }, 5, 50);
  assert.equal(plan.feasible, false);
  assert.ok(plan.maxSends < 50);
});

test("blocks: 6 to 10 mailboxes all fit 50 a day across 08:00-24:00, gaps aligned to 5 minutes", () => {
  for (const n of [6, 7, 8, 9, 10]) {
    const plan = planBlocks(DSW, n, 50);
    assert.equal(plan.feasible, true, `mailboxes=${n}`);
    assert.equal(plan.gapUsed % 5, 0, `gap for ${n} mailboxes`);
    assert.ok(n * plan.perMailbox >= 50, `capacity for ${n} mailboxes`);
  }
});

import { isSendWindowBroken } from "../src/lib/send-window.ts";
import test2 from "node:test";
import assert2 from "node:assert/strict";
test2("a configured but unusable window is broken (never widens to the default)", () => {
  assert2.equal(isSendWindowBroken("03:00:00", "03:01:00"), true); // under 5 minutes
  assert2.equal(isSendWindowBroken("xx", "10:00"), true);
  assert2.equal(isSendWindowBroken("08:00", null), true);
  assert2.equal(isSendWindowBroken("08:00:00", "22:00:00"), false);
  assert2.equal(isSendWindowBroken("22:00", "06:00"), false); // overnight is fine
  assert2.equal(isSendWindowBroken(null, null), false); // unset uses the default
  assert2.equal(isSendWindowBroken("", ""), false);
});
