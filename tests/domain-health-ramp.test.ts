import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMailboxHealth, isMailboxSlow } from "../src/lib/mailbox-health.ts";
import { domainCapForAge, effectiveDailyLimit } from "../src/lib/warmup-schedule.ts";

const S = (sent: number, bounced = 0, complained = 0) => ({ sent, bounced, complained });
const dom = (pairs: [string, string][]) => new Map(pairs);

test("isMailboxSlow: warns at 2% bounces once there are enough sends, never when already unhealthy", () => {
  assert.equal(isMailboxSlow(S(50, 1)), true); // 2%
  assert.equal(isMailboxSlow(S(50, 0)), false);
  assert.equal(isMailboxSlow(S(9, 1)), false); // too few sends to trust
  assert.equal(isMailboxSlow(S(50, 3)), false); // 6% is a pause, not a slow-down
});

test("a mailbox that only warns slows itself; a clean sibling and other domains are untouched", () => {
  const stats = new Map([["a", S(40, 1)], ["b", S(40, 0)]]);
  const h = computeMailboxHealth(stats, dom([["a", "x.com"], ["b", "x.com"], ["c", "y.com"]]));
  assert.equal(h.unhealthy.size, 0); // 2.5% own, 1.25% for the domain: under the pause line
  assert.deepEqual([...h.slow], ["a"]); // own warning only; domain total is fine
});

test("a warning at domain level slows every mailbox on it", () => {
  const stats = new Map([["a", S(30, 1)], ["b", S(30, 1)], ["c", S(30, 1)]]);
  const h = computeMailboxHealth(stats, dom([["a", "x.com"], ["b", "x.com"], ["c", "x.com"], ["idle", "x.com"], ["z", "y.com"]]));
  assert.equal(h.unhealthy.size, 0);
  assert.deepEqual([...h.slow].sort(), ["a", "b", "c", "idle"]); // 3/90 = 3.3%: warning, not pause
  assert.equal(h.slow.has("z"), false);
});

test("many mailboxes each under the per-mailbox limit still pause the domain when the total is bad", () => {
  const stats = new Map<string, ReturnType<typeof S>>();
  const domainOf = new Map<string, string>();
  for (let i = 0; i < 8; i++) {
    stats.set("m" + i, S(14, 2)); // each: 14 sends, 2 bounces -> under 15 sends and under the 3-bounce early limit
    domainOf.set("m" + i, "techy.site");
  }
  for (const id of stats.keys()) assert.equal(computeMailboxHealth(new Map([[id, stats.get(id)!]]), new Map([[id, "techy.site"]])).unhealthy.size, 0);
  const h = computeMailboxHealth(stats, domainOf);
  assert.equal(h.unhealthy.size, 8); // 16/112 = 14%: the domain is paused as a whole
  assert.equal(h.slow.size, 0);
});

test("siblings with no sends of their own are covered by the domain verdict", () => {
  const stats = new Map([["a", S(20, 5)]]);
  const h = computeMailboxHealth(stats, dom([["a", "x.com"], ["idle", "x.com"]]));
  assert.ok(h.unhealthy.has("a") && h.unhealthy.has("idle"));
});

test("healthy domain: nothing paused or slowed", () => {
  const h = computeMailboxHealth(new Map([["a", S(100, 1)], ["b", S(100, 0)]]), dom([["a", "x.com"], ["b", "x.com"]]));
  assert.equal(h.unhealthy.size + h.slow.size, 0);
});

test("effectiveDailyLimit halves the limit when slow, never below 1", () => {
  const created = new Date(Date.now() - 10 * 86400000).toISOString();
  const normal = effectiveDailyLimit({ daily_send_limit: 30, created_at: created });
  assert.equal(normal, 17);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 30, created_at: created }, Date.now(), true, true), 9);
  assert.equal(effectiveDailyLimit({ daily_send_limit: 1, created_at: created }, Date.now(), true, true), 1);
});

test("domainCapForAge ramps with age and never passes the operator ceiling", () => {
  assert.equal(domainCapForAge(0, 100), 20);
  assert.equal(domainCapForAge(10, 100), 50);
  assert.ok(domainCapForAge(25, 100) >= 75 && domainCapForAge(25, 100) <= 77);
  assert.ok(domainCapForAge(400, 100) <= 100);
  assert.equal(domainCapForAge(10, 30), 30); // env ceiling wins
});
