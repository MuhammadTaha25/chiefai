/** QA: each client's own follow_up_delay_days is honoured (A=4 days, B=3 days); mailbox pinned; thread kept. */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";
type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });
const id = (r: { id?: unknown }) => r.id as string;

function setup(days: number) {
  const c = S.seedClient(); const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: days });
  const camp = S.seedCampaign(cid);
  const mb = S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  const lead = S.seedLead(cid, { campaign_id: id(camp), created_at: new Date(S.now() - S.DAY).toISOString() });
  return { cid, lead: id(lead), mb: id(mb) };
}

test("client A (4 days) and client B (3 days): follow-ups go out exactly at their own gap", async () => {
  const A = setup(4), B = setup(3);
  await app.sendBatch.sendBatchForClient(A.cid);
  await app.sendBatch.sendBatchForClient(B.cid);
  assert.equal(S.mailer.sent.length, 2, "both first emails sent");
  const t0 = S.now();
  const dueA = Date.parse(S.leadRow(A.lead).next_follow_up_at as string) - t0;
  const dueB = Date.parse(S.leadRow(B.lead).next_follow_up_at as string) - t0;
  assert.ok(Math.abs(dueA - 4 * S.DAY) < S.MIN, "A due in 4 days");
  assert.ok(Math.abs(dueB - 3 * S.DAY) < S.MIN, "B due in 3 days");
  const runAll = async () => { for (const c of [A, B]) await app.followUps.runFollowUpBatch({ clientIdFilter: c.cid, isCron: false }); };
  S.setClock(t0 + 3 * S.DAY - 5 * S.MIN); await runAll();
  assert.equal(S.mailer.sent.length, 2, "nobody due yet");
  S.setClock(t0 + 3 * S.DAY + 5 * S.MIN); await runAll();
  assert.equal(S.mailer.sent.length, 3, "only B (3 days) went out");
  assert.equal(S.mailer.sent[2].to, S.leadRow(B.lead).email);
  S.setClock(t0 + 4 * S.DAY - 5 * S.MIN); await runAll();
  assert.equal(S.mailer.sent.length, 3, "A not yet");
  S.setClock(t0 + 4 * S.DAY + 5 * S.MIN); await runAll();
  assert.equal(S.mailer.sent.length, 4, "A went out at 4 days");
  assert.equal(S.mailer.sent[3].to, S.leadRow(A.lead).email);
  // pinned mailbox + thread
  for (const m of S.mailer.sent.slice(2)) assert.ok(m.inReplyTo, "threaded");
});

test("follow-up is NOT sent outside the client's send window, and goes out once the window opens", async () => {
  const c = S.seedClient({ timezone: "Asia/Karachi", outreach_send_start: "08:00:00", outreach_send_end: "22:00:00" });
  const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const mb = S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  const lead = S.seedSentLead(cid, id(mb));
  // 2026-10-14 22:30 UTC = 03:30 PKT -> closed
  S.setClock(Date.UTC(2026, 9, 14, 22, 30, 0));
  const closed = await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: false });
  assert.equal(S.mailer.sent.length, 0, "no follow-up at 3:30am local");
  assert.match(String(closed.results[0].detail), /send window/);
  assert.ok(S.leadRow(id(lead)).next_follow_up_at, "lead keeps its schedule");
  // 05:30 UTC = 10:30 PKT -> open
  S.setClock(Date.UTC(2026, 9, 15, 5, 30, 0));
  await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: false });
  assert.equal(S.mailer.sent.length, 1, "goes out in the morning");
});

test("a lead whose follow-up claim was orphaned (no schedule, not finished) is put back in the queue by the cron", async () => {
  const c = S.seedClient({ timezone: "Asia/Karachi" });
  const cid = id(c);
  S.seedJob(cid, { follow_up_delay_days: 3, follow_ups: "2 follow-ups" });
  const mb = S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  const orphan = S.seedSentLead(cid, id(mb), { lead: { last_contact_at: new Date(S.now() - 4 * S.HOUR).toISOString(), next_follow_up_at: null } });
  const finished = S.seedSentLead(cid, id(mb), { lead: { follow_up_number: 3, last_contact_at: new Date(S.now() - 4 * S.HOUR).toISOString(), next_follow_up_at: null } });
  await app.followUps.runFollowUpBatch({ clientIdFilter: null, isCron: true });
  assert.ok(S.leadRow(id(orphan)).next_follow_up_at, "orphan is scheduled again");
  assert.equal(S.leadRow(id(finished)).next_follow_up_at, null, "a finished sequence stays finished");
});
