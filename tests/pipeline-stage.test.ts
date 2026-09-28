import { test } from "node:test";
import assert from "node:assert/strict";
import { stageForLead } from "../src/lib/pipeline-stage.ts";

test("never-emailed leads are not on the pipeline", () => {
  assert.equal(stageForLead({ status: "new" }), null);
});

test("sent, with follow-up count", () => {
  assert.deepEqual(stageForLead({ status: "email_sent", follow_up_number: 1, last_contact_at: "2026-09-25" }), { stage: "sent", detail: "First email sent" });
  assert.deepEqual(stageForLead({ status: "follow_up_3", follow_up_number: 3 }), { stage: "sent", detail: "Follow-up 2 sent" });
});

test("a reply moves the lead to negotiation with the reason", () => {
  assert.deepEqual(stageForLead({ reply_received: true, reply_classification: "BOOKING", follow_up_number: 1 }), { stage: "negotiation", detail: "Replied: wants to book" });
  assert.equal(stageForLead({ reply_received: true, reply_classification: "HAPPY" })?.detail, "Replied: interested");
  assert.equal(stageForLead({ reply_received: true, reply_classification: "UNCLEAR" })?.stage, "negotiation");
});

test("booked is won, even if they later unsubscribe", () => {
  assert.equal(stageForLead({ booked: true, unsubscribed: true })?.stage, "won");
  assert.equal(stageForLead({ status: "booked" })?.stage, "won");
});

test("bounce, spam complaint, unsubscribe, angry reply and manual stop are lost", () => {
  for (const l of [{ email_bounced: true }, { complained: true }, { unsubscribed: true }, { reply_received: true, reply_classification: "ANGRY" }, { manually_stopped: true, last_contact_at: "x" }]) {
    assert.equal(stageForLead(l)?.stage, "lost", JSON.stringify(l));
  }
});
