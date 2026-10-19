import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsubscribeRequest, isAutomatedMessage, withUnsubscribeFooter, unsubscribeHeaders, unsubscribeConfirmation } from "../src/lib/compliance.ts";

test("unsubscribe requests are recognised in the ways people actually write them", () => {
  for (const t of ["unsubscribe", "Please UNSUBSCRIBE me", "remove me from your list", "take me off this list", "stop emailing me", "don't contact me again", "do not email me", "I want to opt out", "opt-out", "leave me alone", "stop contacting us", "never email me again"]) {
    assert.equal(isUnsubscribeRequest(t), true, t);
  }
});

test("a bare STOP still opts out, in the ways people write it", () => {
  for (const t of ["STOP", "stop", "Stop.", "Please stop", "STOP\n\nOn Mon, Oct 19 wrote:\n> Not interested?", "Stop. Not interested.", "please stop these emails"]) {
    assert.equal(isUnsubscribeRequest(t), true, t);
  }
});

test("friendly uses of the word stop are not opt-outs", () => {
  for (const t of ["Can you stop by Friday?", "I'll stop by your office tomorrow", "We should stop in next week", "Don't stop sending me updates", "please do not stop the project", "Let's not stop here, send details"]) {
    assert.equal(isUnsubscribeRequest(t), false, t);
  }
});

test("normal replies are not mistaken for unsubscribe requests", () => {
  for (const t of ["Sounds interesting, can you send details?", "Not right now, maybe next quarter", "Who are you?", "Thanks, we already have a provider"]) {
    assert.equal(isUnsubscribeRequest(t), false, t);
  }
});

test("machine mail is never auto-answered (bounces, out-of-office, no-reply, lists)", () => {
  assert.equal(isAutomatedMessage("MAILER-DAEMON@mx.example.com", null), true);
  assert.equal(isAutomatedMessage("Postmaster <postmaster@example.com>", null), true);
  assert.equal(isAutomatedMessage("no-reply@shop.com", null), true);
  assert.equal(isAutomatedMessage("Jo <jo@acme.com>", JSON.stringify([["Auto-Submitted", "auto-replied"]])), true);
  assert.equal(isAutomatedMessage("Jo <jo@acme.com>", JSON.stringify([["Precedence", "bulk"]])), true);
  assert.equal(isAutomatedMessage("Jo <jo@acme.com>", JSON.stringify([["List-Unsubscribe", "<mailto:x@y.z>"]])), true);
  assert.equal(isAutomatedMessage("Jo <jo@acme.com>", JSON.stringify([["Auto-Submitted", "no"]])), false);
});

test("a real person's reply is not treated as automated, even with broken header data", () => {
  assert.equal(isAutomatedMessage("Sam Agent <sam@acme.com>", null), false);
  assert.equal(isAutomatedMessage("Sam Agent <sam@acme.com>", "not json"), false);
  assert.equal(isAutomatedMessage("Sam Agent <sam@acme.com>", JSON.stringify({ not: "an array" })), false);
});

test("footer: opt-out line, company and postal address; works with and without an address", () => {
  const full = withUnsubscribeFooter("Hello.\n\n", { company: "Test Co", postalAddress: "1 Test St" });
  assert.equal(full, 'Hello.\n\n--\nNot interested? Reply "STOP" and we will not email you again.\nTest Co · 1 Test St');
  const bare = withUnsubscribeFooter("Hello.", { company: null });
  assert.ok(bare.includes('Reply "STOP"'));
  assert.ok(!bare.includes("·"));
  // No postal address: the company name is NOT repeated in the footer (it is already in the signature).
  const noAddress = withUnsubscribeFooter("Hello.", { company: "Test Co" });
  assert.equal(noAddress, 'Hello.\n\n--\nNot interested? Reply "STOP" and we will not email you again.');
  assert.ok(isUnsubscribeRequest(full.split("--")[1]), "the footer's own instruction is something the inbound handler understands");
});

test("List-Unsubscribe header and the confirmation message", () => {
  assert.deepEqual(unsubscribeHeaders("a@b.test"), { "List-Unsubscribe": "<mailto:a@b.test?subject=unsubscribe>" });
  assert.match(unsubscribeConfirmation("Test Co").body, /Test Co/);
});

test("lint rejects invented statistics and customer claims", async () => {
  const { lintOutreachEmail } = await import("../src/lib/email-quality.ts");
  const base = "Hi Sam, most agencies lose warm buyers when replies come late. We set up automatic replies so every enquiry gets an answer within minutes. Would a quick chat next week help?";
  assert.deepEqual(lintOutreachEmail({ subject: "quick idea", body: base }, { firstTouch: false }), []);
  assert.ok(lintOutreachEmail({ subject: "quick idea", body: "Hi Sam, clients report saving 10+ hours per week with our automations for agencies like yours. Worth a chat?" }, { firstTouch: false }).length >= 1);
  assert.ok(lintOutreachEmail({ subject: "quick idea", body: base + " We lift replies by 40%." }, { firstTouch: false }).includes("invented statistic"));
  assert.deepEqual(lintOutreachEmail({ subject: "quick idea", body: base + " Open to a 15-minute call?" }, { firstTouch: false }), []);
});

test("spam score: normal outreach stays under the limit, stacked spam signals fail", async () => {
  const { spamScore, lintOutreachEmail, SPAM_SCORE_LIMIT } = await import("../src/lib/email-quality.ts");
  const ok = { subject: "quick question about acme realty", body: "Hi Sam, most agencies like Acme Realty lose warm buyers when replies come late. We set up automatic replies so every enquiry gets an answer within minutes. Would a quick chat next week help?" };
  assert.ok(spamScore(ok).total < SPAM_SCORE_LIMIT);
  assert.deepEqual(lintOutreachEmail(ok), []);
  const spammy = { subject: "AMAZING OFFER $$ just for you", body: "Hi Sam, special offer: save big with our game-changer, only 3 spots left, hurry. Reply now at bit.ly/xyz to get a discount on a proven system for your agency this week." };
  const s = spamScore(spammy);
  assert.ok(s.total >= SPAM_SCORE_LIMIT, `score ${s.total}`);
  assert.ok(lintOutreachEmail(spammy).some((i) => i.startsWith("spam score")));
  // one weak signal alone is allowed
  assert.ok(spamScore({ subject: "idea for acme", body: ok.body + " Happy to leverage what we have built." }).total < SPAM_SCORE_LIMIT);
  // obfuscation is caught
  assert.ok(spamScore({ subject: "idea", body: "Hi Sam, get f.r.e.e.d.o.m from slow replies with our tool, it works well for most agencies and teams. Open to a short chat next week?" }).hits.includes("obfuscated text"));
});

test("lint rejects a follow-up that copies earlier wording, and subjects over 50 characters", async () => {
  const { lintOutreachEmail } = await import("../src/lib/email-quality.ts");
  const first = "Hi Sam, most agencies lose warm buyers when replies come late. We set up automatic replies so every enquiry gets an answer within minutes. Would a quick chat next week help?";
  const copy = "Hi Sam, most agencies lose warm buyers when replies come late. We set up automatic replies so every enquiry gets answered. Is a short chat this week useful?";
  assert.ok(lintOutreachEmail({ subject: "quick idea", body: copy }, { firstTouch: false, earlierBodies: [first] }).includes("repeats wording from earlier emails"));
  const fresh = "Hi Sam, how do you handle enquiries that arrive while your team is out at viewings? Curious whether anything slips through on busy days. Is that something you notice?";
  assert.deepEqual(lintOutreachEmail({ subject: "quick idea", body: fresh }, { firstTouch: false, earlierBodies: [first] }), []);
  assert.ok(lintOutreachEmail({ subject: "a very long subject line that goes well past fifty characters", body: fresh }, { firstTouch: false }).some((i) => i.startsWith("subject longer")));
});

test("lint: subject must relate to the body, and the closing question must be short", async () => {
  const { lintOutreachEmail, subjectMatchesBody } = await import("../src/lib/email-quality.ts");
  const body = "Hi Sam, most agencies lose warm buyers when replies come late. We set up automatic replies so every enquiry gets an answer within minutes. Would a quick chat next week help?";
  assert.equal(subjectMatchesBody("faster replies for agencies", body), true);
  assert.equal(subjectMatchesBody("your invoice is ready", body), false);
  assert.ok(lintOutreachEmail({ subject: "your invoice is ready", body }).includes("subject does not match the email"));
  const long = body.replace("Would a quick chat next week help?", "Would it be at all possible for you to find some time next week to have a really quick chat with me about whether any of this could help your team right now?");
  assert.ok(lintOutreachEmail({ subject: "faster replies for agencies", body: long }).includes("closing question too long"));
});
