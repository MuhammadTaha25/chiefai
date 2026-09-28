import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOutreachEmail, lintOutreachEmail } from "../src/lib/email-quality.ts";

const good = {
  subject: "Quick question about Acme Dental",
  body: "Hi Sam, I noticed Acme Dental recently opened a second clinic in Leeds. Many multi-site practices lose bookings when the phones get busy, and we help them capture those calls automatically. Would it be useful if I showed you how it works on a short call this week? Thanks, Priya at Nova",
};

test("a plain, personal email passes", () => {
  assert.deepEqual(lintOutreachEmail(good), []);
});

test("spam triggers, links, shouting and exclamation marks are flagged", () => {
  const bad = { subject: "FREE!!! GROW YOUR BUSINESS NOW", body: "Click here www.example.com to get a guaranteed result! Act now! " + "word ".repeat(30) };
  const issues = lintOutreachEmail(bad).join("|");
  assert.match(issues, /spam trigger: "free"/);
  assert.match(issues, /spam trigger: "click here"/);
  assert.match(issues, /link in first email/);
  assert.match(issues, /exclamation/);
});

test("clean removes fake Re:, shouting, markdown and !", () => {
  const c = cleanOutreachEmail({ subject: "RE: GROW YOUR BUSINESS!!", body: "**Hi** there!!\n\n\n\n- item" });
  assert.equal(c.subject, "Grow your business");
  assert.equal(c.body, "Hi there!\n\n- item");
});

test("follow-ups may contain links and skip the first-touch length cap", () => {
  const issues = lintOutreachEmail({ subject: "Following up", body: good.body + " " + "more words ".repeat(40) + " https://cal.example.com/x" }, { firstTouch: false });
  assert.deepEqual(issues, []);
});

test("too-short and emoji are flagged", () => {
  assert.match(lintOutreachEmail({ subject: "Hi 😀", body: "Hello." }).join("|"), /emoji/);
  assert.match(lintOutreachEmail({ subject: "Hi", body: "Hello." }).join("|"), /too short/);
});
