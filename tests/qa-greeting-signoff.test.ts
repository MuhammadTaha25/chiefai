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

// ---------------------------------------------------------------- edge cases of applyGreetingAndSignoff
const frame = (body: string, greetingName: string | null = "Sam Agent", senderName = "Infomist") => applyGreetingAndSignoff({ subject: "s", body }, { greetingName, senderName }).body;
const MSG = "Most agencies reply late to new enquiries. Would a short example help?";

test("model variants of greeting are all replaced by exactly one system greeting", () => {
  for (const g of ["Hi Sam,", "Hello Sam,", "Hey there,", "Dear Sam,", "Good morning Sam,", "Hi,"]) {
    const out = frame(`${g}\n\n${MSG}\n\nBest,\nX`);
    assert.equal(out, `Hi Sam,\n\n${MSG}\n\nBest,\nInfomist`, `greeting variant ${g}`);
  }
});
test("model variants of sign-off are all replaced by exactly one system sign-off", () => {
  for (const s of ["Best,\nX", "Best regards,\nX Y", "Kind regards,\nX\nCEO", "Thanks,\nX", "Cheers,\nX", "Sincerely,\nX Y\nFounder\nacme.com", "Thank you,\nX", "X Y"]) {
    const out = frame(`${MSG}\n\n${s}`);
    assert.equal(out, `Hi Sam,\n\n${MSG}\n\nBest,\nInfomist`, `sign-off variant ${JSON.stringify(s)}`);
  }
});
test("no greeting and no sign-off written by the model: both added, content untouched", () => {
  assert.equal(frame(MSG), `Hi Sam,\n\n${MSG}\n\nBest,\nInfomist`);
});
test("a real closing question is never mistaken for a sign-off", () => {
  const out = frame("Most agencies reply late to new enquiries and lose buyers.\n\nWorth a quick chat?");
  assert.match(out, /Worth a quick chat\?/);
  const out2 = frame("Most agencies reply late.\n\nWe fix that.");
  assert.match(out2, /We fix that\./);
});
test("idempotent: framing an already framed email changes nothing", () => {
  const once = frame(`Hi Sam,\n\n${MSG}\n\nBest,\nX`);
  assert.equal(frame(once), once);
});
test("business lead and missing name greet generically; the lead's FIRST name only", () => {
  assert.match(frame(MSG, null), /^Hi there,/);
  assert.match(frame(MSG, ""), /^Hi there,/);
  assert.match(frame(MSG, "  Dana   Lee-Smith "), /^Hi Dana,/);
});
test("sender name: special characters kept, header-injection characters removed, empty falls back to Team", () => {
  assert.match(frame(MSG, "Sam", "Smith & Sons"), /Best,\nSmith & Sons$/);
  assert.match(frame(MSG, "Sam", 'Evil"<b>\nBcc: x@y.z'), /Best,\nEvilbBcc: x@y\.z$/);
  assert.match(frame(MSG, "Sam", "   "), /Best,\nTeam$/);
});
test("subject is never touched", () => {
  assert.equal(applyGreetingAndSignoff({ subject: "quick question", body: MSG }, { greetingName: "Sam", senderName: "A" }).subject, "quick question");
});

// ---------------------------------------------------------------- through the real pipeline
test("follow-ups are framed too: greeting for the lead, sign-off of the client, one of each", async () => {
  const c = S.seedClient({ company_name: "Infomist" }); const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const mb = S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  S.seedSentLead(cid, id(mb), { lead: { name: "Dana Lee", company: "Dana Realty", job_title: "Owner" } });
  S.ai.rotateBodies = false;
  S.ai.followUpBody = "Hello Dana,\n\nQuick thought: late replies cost busy agencies buyers who then call the next agent on their list instead. Would a short chat next week suit you?\n\nRegards,\nSomeone Else";
  await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: false });
  assert.equal(S.mailer.sent.length, 1);
  const t = S.mailer.sent[0].text;
  assert.match(t, /^Hi Dana,/);
  assert.equal((t.match(/^Hi /gm) ?? []).length, 1);
  assert.match(t, /Best,\nInfomist\n/);
  assert.ok(!/Someone Else|Regards|Hello Dana/.test(t));
  S.ai.rotateBodies = true;
});

test("business lead (name = company): first email greets 'there' and mentions no personal name", async () => {
  const A = client("Infomist", "Harbor Lane Realty", "Harbor Lane Realty");
  await app.sendBatch.sendBatchForClient(A.cid);
  assert.equal(S.mailer.sent.length, 1);
  assert.match(S.mailer.sent[0].text, /^Hi there,/);
  assert.match(S.mailer.sent[0].text, /Best,\nInfomist\n/);
});

test("every email in a 3-follow-up sequence has exactly one greeting and one sign-off, with the client's name", async () => {
  const c = S.seedClient({ company_name: "Infomist" }); const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 1, follow_ups: "3 follow-ups" });
  const camp = S.seedCampaign(cid);
  S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  S.seedLead(cid, { campaign_id: id(camp), name: "Sam Agent", created_at: new Date(S.now() - S.DAY).toISOString() });
  await app.sendBatch.sendBatchForClient(cid);
  for (let i = 0; i < 3; i++) { S.setClock(S.now() + 25 * S.HOUR); await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: false }); }
  assert.equal(S.mailer.sent.length, 4, "first email + 3 follow-ups");
  for (const m of S.mailer.sent) {
    assert.equal((m.text.match(/^Hi /gm) ?? []).length, 1, "one greeting");
    assert.equal((m.text.match(/^Best,$/gm) ?? []).length, 1, "one sign-off");
    assert.match(m.text, /Best,\nInfomist\n/);
  }
});
