import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeProspects, normEmail } from "../src/lib/prospect-dedupe.ts";
import { currentCampaignMonth } from "../src/lib/campaign.ts";

test("dedupe removes existing (any case) and in-batch repeats", () => {
  const out = dedupeProspects([{ email: "A@x.com" }, { email: "a@X.com" }, { email: "b@x.com" }, { email: null }], ["B@x.com"]);
  assert.deepEqual(out.map((p) => normEmail(p.email)), ["a@x.com", ""]);
});


test("campaign month is the UTC first of month", () => {
  assert.equal(currentCampaignMonth(new Date("2026-09-24T10:00:00Z")), "2026-09-01");
});

import { autoSendSince, FORM_LEAD_SOURCE } from "../src/lib/campaign.ts";

test("auto-send cutoff: unset = none, valid = ISO, invalid fails closed", () => {
  assert.equal(autoSendSince({}), null);
  assert.equal(autoSendSince({ AUTO_SEND_LEADS_SINCE: "2026-09-26T00:00:00Z" }), "2026-09-26T00:00:00.000Z");
  assert.equal(autoSendSince({ AUTO_SEND_LEADS_SINCE: "not a date" }), "9999-12-31T00:00:00.000Z");
  assert.equal(FORM_LEAD_SOURCE, "ai_prospecting");
});
