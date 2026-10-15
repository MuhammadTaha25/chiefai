import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureBookingLink, leadMeetingEventName } from "../src/lib/booking-link.ts";
import { isMailboxHealthy } from "../src/lib/mailbox-health.ts";

test("ensureBookingLink appends the link when the model dropped it", () => {
  const out = ensureBookingLink("Thanks for replying!", "https://calendly.com/acme/intro");
  assert.match(out, /https:\/\/calendly\.com\/acme\/intro$/);
});

test("ensureBookingLink does not duplicate a link already present (trailing slash tolerant)", () => {
  const body = "Book here:\nhttps://calendly.com/acme/intro\nThanks";
  assert.equal(ensureBookingLink(body, "https://calendly.com/acme/intro/"), body);
});

test("ensureBookingLink leaves the body alone when there is no link", () => {
  assert.equal(ensureBookingLink("Hi", null), "Hi");
  assert.equal(ensureBookingLink("Hi", "  "), "Hi");
});

test("leadMeetingEventName uses the tenant's company and topic, never a generic name", () => {
  assert.equal(leadMeetingEventName("Infomist", "AI receptionist demo"), "Infomist – AI receptionist demo");
  assert.equal(leadMeetingEventName("Infomist", null), "Infomist – Intro call");
  assert.equal(leadMeetingEventName(null, null), "Intro call");
  assert.ok(leadMeetingEventName("A\nB", "x".repeat(300)).length <= 120);
});

test("mailbox health: low volume stays eligible, high bounce/complaint rates are paused", () => {
  assert.equal(isMailboxHealthy({ sent: 5, bounced: 2, complained: 0 }), true);
  assert.equal(isMailboxHealthy({ sent: 5, bounced: 3, complained: 0 }), false); // early red flag
  assert.equal(isMailboxHealthy({ sent: 100, bounced: 5, complained: 0 }), false); // above 4%
  assert.equal(isMailboxHealthy({ sent: 100, bounced: 4, complained: 0 }), true);
  assert.equal(isMailboxHealthy({ sent: 5, bounced: 0, complained: 2 }), false);
  assert.equal(isMailboxHealthy({ sent: 100, bounced: 3, complained: 0 }), true);
  assert.equal(isMailboxHealthy({ sent: 100, bounced: 12, complained: 0 }), false);
  assert.equal(isMailboxHealthy({ sent: 100, bounced: 0, complained: 1 }), false);
});

import { resolveDailySendCap } from "../src/lib/send-cap.ts";

test("daily cap: with no override the mailboxes' combined capacity is the cap; with no mailboxes the historical 4/day", () => {
  assert.equal(resolveDailySendCap(null, 90), 90);
  assert.equal(resolveDailySendCap(0, 90), 90);
  assert.equal(resolveDailySendCap(undefined, 0), 4);
  assert.equal(resolveDailySendCap(null, 0), 4);
});

test("daily cap: override is limited by what the tenant's mailboxes can send (warmup-aware)", () => {
  assert.equal(resolveDailySendCap(150, 90), 90); // 3 mailboxes at the 30/day warmup cap
  assert.equal(resolveDailySendCap(150, 150), 150); // 5 mailboxes
  assert.equal(resolveDailySendCap(60, 90), 60);
});
