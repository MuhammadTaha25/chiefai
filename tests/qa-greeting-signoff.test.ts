/** QA: every email carries the greeting for ITS lead and the sign-off of ITS client; nothing leaks between clients or leads. */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";
import { applyGreetingAndSignoff } from "../src/lib/email-quality.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });
const id = (r: { id?: unknown }) => r.id as string;

test("greeting + sign-off are system-made; model-written ones are replaced", () => {
  const out = applyGreetingAndSignoff({ subject: "x", body: "Hi Sam,\n\nMost agencies reply late. Would a short example help?\n\nBest regards,\nWrong Co" }, { greetingName: "Dana Lee", senderName: "Infomist" });
  assert.equal(out.body, "Hi Dana,\n\nMost agencies reply late. Would a short example help?\n\nBest,\nInfomist");
  const lone = applyGreetingAndSignoff({ subject: "x", body: "QA Realty One handles many enquiries. Would a quick call help?\n\na" }, { greetingName: null, senderName: "Infomist" });
  assert.equal(lone.body, "Hi there,\n\nQA Realty One handles many enquiries. Would a quick call help?\n\nBest,\nInfomist");
});

function client(company: string, leadName: string, leadCompany: string) {
  const c = S.seedClient({ company_name: company }); const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const camp = S.seedCampaign(cid);
  S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  const lead = S.seedLead(cid, { campaign_id: id(camp), name: leadName, company: leadCompany, job_title: "Owner", created_at: new Date(S.now() - S.DAY).toISOString() });
  return { cid, lead: id(lead) };
}

test("two clients: each email signs with its own company and greets its own lead, nothing from the other client", async () => {
  const A = client("A", "Star Person", "Star Realty");
  const B = client("Infomist", "Galaxy Person", "Galaxy Realty");
  S.ai.aidaBody = "Hi someone,\n\nMost real estate teams lose warm enquiries because replies come hours late. We set up automatic replies and follow-ups so every enquiry gets an answer within minutes.\n\nWould it be useful if I sent a short example?\n\nThanks,\nSomebody Else";
  await app.sendBatch.sendBatchForClient(A.cid);
  await app.sendBatch.sendBatchForClient(B.cid);
  assert.equal(S.mailer.sent.length, 2);
  const [mA, mB] = S.mailer.sent;
  assert.match(mA.text, /Hi Star,/); assert.match(mA.text, /Best,\nA\n/);
  assert.match(mB.text, /Hi Galaxy,/); assert.match(mB.text, /Best,\nInfomist\n/);
  assert.ok(!/Galaxy|Infomist/.test(mA.text), "client A's email has nothing of client B");
  assert.ok(!/Star Realty|Star,|\nA\n/.test(mB.text), "client B's email has nothing of client A");
  assert.ok(!/Somebody Else|Thanks,/.test(mA.text + mB.text), "model-written sign-off removed");
});
