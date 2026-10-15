import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsubscribeRequest, isAutomatedMessage, withUnsubscribeFooter, unsubscribeHeaders, unsubscribeConfirmation } from "../src/lib/compliance.ts";

test("unsubscribe requests are recognised in the ways people actually write them", () => {
  for (const t of ["unsubscribe", "Please UNSUBSCRIBE me", "remove me from your list", "take me off this list", "stop emailing me", "don't contact me again", "do not email me", "I want to opt out", "opt-out", "leave me alone", "stop contacting us", "never email me again"]) {
    assert.equal(isUnsubscribeRequest(t), true, t);
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
  assert.equal(full, 'Hello.\n\n--\nIf you would rather not hear from us, just reply with "unsubscribe" and we will not email you again.\nTest Co · 1 Test St');
  const bare = withUnsubscribeFooter("Hello.", { company: null });
  assert.ok(bare.includes('reply with "unsubscribe"'));
  assert.ok(!bare.includes("·"));
  assert.ok(isUnsubscribeRequest(full.split("--")[1]), "the footer's own instruction is something the inbound handler understands");
});

test("List-Unsubscribe header and the confirmation message", () => {
  assert.deepEqual(unsubscribeHeaders("a@b.test"), { "List-Unsubscribe": "<mailto:a@b.test?subject=unsubscribe>" });
  assert.match(unsubscribeConfirmation("Test Co").body, /Test Co/);
});
