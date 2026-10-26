import { test } from "node:test";
import assert from "node:assert/strict";
import { stripQuestions } from "../src/lib/gemini.ts";

test("LATER ack: question sentences are removed, even without a question mark", () => {
  const out = stripQuestions(
    "Thank you for letting me know, Priya. There is no pressure at all. I will be in touch again soon. Does that sound good",
  );
  assert.equal(out, "Thank you for letting me know, Priya. There is no pressure at all. I will be in touch again soon.");
  assert.ok(!out.includes("?"));
});

test("LATER ack: sign-off paragraphs survive", () => {
  const out = stripQuestions("Thanks, Priya. No pressure. Is that fine?\n\nBest,\nInfomist QA");
  assert.equal(out, "Thanks, Priya. No pressure.\n\nBest,\nInfomist QA");
});

test("ANGRY reply: a trailing 'Should I remove you...' question is removed", () => {
  const out = stripQuestions(
    "Hi Priya,\n\nI am sincerely sorry for the interruption. I will not push our services on you.\n\nShould I remove you from our list?",
  );
  assert.ok(!out.includes("?"));
  assert.ok(!out.includes("Should I remove"));
  assert.ok(out.includes("sincerely sorry"));
});
