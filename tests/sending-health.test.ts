import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSendingHealth, domainProblems, type SendingHealthInput } from "../src/lib/sending-health-core.ts";

const base: SendingHealthInput = {
  campaignActive: true,
  timezoneValid: true,
  windowStart: "08:00",
  windowEnd: "22:00",
  nowMinute: 14 * 60,
  mailboxes: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, address: `m${i}@d.test` })),
  dailyCap: 32,
  sentToday: 1,
  sentTodayByMailbox: { m3: 1 },
  eligibleLeads: 1,
  domains: [{ domain: "d.test", dns_status: "active", dns_health: { checks: [{ kind: "spf", status: "ok" }] } }],
};

test("missing timezone is bad and says what to do", () => {
  const h = buildSendingHealth({ ...base, timezoneValid: false });
  assert.equal(h.level, "bad");
  assert.match(h.details.join(" "), /timezone/i);
});

test("invalid window is bad", () => {
  const h = buildSendingHealth({ ...base, windowStart: "10:00", windowEnd: "10:02" });
  assert.equal(h.level, "bad");
  assert.match(h.details.join(" "), /window/i);
});

test("no mailbox is bad", () => {
  assert.equal(buildSendingHealth({ ...base, mailboxes: [] }).level, "bad");
});

test("failing DNS check and not-in-mailgun are reported per domain", () => {
  const p = domainProblems([
    { domain: "a.test", dns_status: "active", dns_health: { checks: [{ kind: "dkim", status: "missing" }, { kind: "spf", status: "ok" }] } },
    { domain: "b.test", dns_status: "active", dns_health: { problem: "not_in_mailgun", checks: [] } },
    { domain: "c.test", dns_status: "provisioning_failed" },
  ]);
  assert.equal(p.length, 3);
  assert.match(p[0], /a\.test.*DKIM/);
  assert.match(p[1], /Mailgun/);
  assert.match(p[2], /c\.test.*provisioning_failed/);
});

test("no active campaign is a warning, not an error", () => {
  assert.equal(buildSendingHealth({ ...base, campaignActive: false }).level, "warn");
});

test("daily limit reached is ok and says so", () => {
  const h = buildSendingHealth({ ...base, sentToday: 32 });
  assert.equal(h.level, "ok");
  assert.match(h.headline, /limit/i);
});

test("a break between mailbox blocks is ok and names the next start time", () => {
  // cap 32 over 8 mailboxes => blocks of 40 min with 60 min breaks; 14:00 is a break.
  const h = buildSendingHealth({ ...base, nowMinute: 14 * 60 });
  assert.equal(h.level, "ok");
  assert.match(h.headline, /break/i);
  assert.match(h.headline, /\d\d:\d\d/);
});

test("inside a block with leads waiting says sending is working", () => {
  const h = buildSendingHealth({ ...base, nowMinute: 8 * 60 + 5, sentToday: 0, sentTodayByMailbox: {} });
  assert.equal(h.level, "ok");
  assert.match(h.headline, /Sending is working/);
});

test("inside a block with no leads says nothing is waiting", () => {
  const h = buildSendingHealth({ ...base, nowMinute: 8 * 60 + 5, sentToday: 0, sentTodayByMailbox: {}, eligibleLeads: 0 });
  assert.match(h.headline, /No new leads/);
});

test("a problem is never hidden behind a friendly wait message", () => {
  const h = buildSendingHealth({ ...base, nowMinute: 14 * 60, domains: [{ domain: "x.test", dns_status: "provisioning_failed" }] });
  assert.equal(h.level, "bad");
});
