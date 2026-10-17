/** QA: a lead only ever gets emails about ITS OWN industry (first email AND follow-ups), and every email ends in a question (AIDA action). */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";
import { lintOutreachEmail, industryMismatch, industryFamilies } from "../src/lib/email-quality.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });
const id = (r: { id?: unknown }) => r.id as string;

test("industry families", () => {
  assert.deepEqual(industryFamilies("real estate agent"), ["real_estate"]);
  assert.deepEqual(industryFamilies("restaurant"), ["food"]);
  assert.deepEqual(industryFamilies(null), []);
});
test("lint: food wording to a real-estate lead is rejected, own-industry wording passes", () => {
  const food = "Hi Sam,\n\nMost restaurants lose guests when the menu questions go unanswered. We reply to every enquiry within minutes so your team can focus on the kitchen.\n\nWould a short example help?\n\nBest,\nTest Co";
  const re = "Hi Sam,\n\nMost real estate teams lose warm enquiries when replies come late. We reply to every enquiry within minutes so your agents can focus on viewings.\n\nWould a short example help?\n\nBest,\nTest Co";
  assert.ok(lintOutreachEmail({ subject: "quick question for you", body: food }, { firstTouch: true, industry: "real estate agent" }).some((i) => i.startsWith("wrong industry")));
  assert.equal(lintOutreachEmail({ subject: "quick question for you", body: re }, { firstTouch: true, industry: "real estate agent" }).filter((i) => i.startsWith("wrong industry")).length, 0);
  assert.equal(industryMismatch(food, null).length, 0, "unknown industry -> no false alarm");
});
test("lint: an email without a closing question fails AIDA action", () => {
  const body = "Hi Sam,\n\nMost real estate teams lose warm enquiries when replies come late. We reply to every enquiry within minutes so your agents can focus on viewings and closing deals today.\n\nBest,\nTest Co";
  assert.ok(lintOutreachEmail({ subject: "quick idea for agents", body }, { firstTouch: true }).some((i) => /call to action/.test(i)));
});

function world(industry: string | null) {
  const c = S.seedClient(); const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const camp = S.seedCampaign(cid);
  const mb = S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  return { cid, camp, mb, industry };
}

test("first email: the AI is told the lead's industry; a wrong-industry draft is NOT sent (template used instead)", async () => {
  const w = world("dentist");
  const lead = S.seedLead(w.cid, { campaign_id: id(w.camp), industry: "dentist", company: "Bright Smiles" });
  // default AI body talks about real estate -> wrong for a dentist
  await app.sendBatch.sendBatchForClient(w.cid);
  assert.equal(S.mailer.sent.length, 1);
  assert.equal(S.ai.aidaCalls[0].leadIndustry, "dentist");
  const body = S.mailer.sent[0].text.toLowerCase();
  assert.ok(!/real estate/.test(body), "no real-estate wording in a dentist's email");
  assert.ok(/dentist/.test(body), "template names the lead's own industry");
  assert.equal(S.leadRow(id(lead)).status, "email_sent");
});

test("follow-up: AI is given the lead's industry; wrong-industry drafts never go out", async () => {
  const w = world("real estate agent");
  const lead = S.seedSentLead(w.cid, id(w.mb), { lead: { industry: "real estate agent" } });
  S.ai.rotateBodies = false;
  S.ai.followUpBody = "Hey there, quick thought: restaurants lose guests when menu questions sit unanswered. Would a short chat next week suit you?";
  const r = await app.followUps.runFollowUpBatch({ clientIdFilter: w.cid, isCron: false });
  assert.equal(S.ai.followUpCalls[0].leadIndustry, "real estate agent");
  assert.equal(S.mailer.sent.length, 0, "food-wording follow-up to a realtor must not be sent");
  assert.notEqual(r.results[0].result, "sent");
  S.ai.rotateBodies = true;
});
