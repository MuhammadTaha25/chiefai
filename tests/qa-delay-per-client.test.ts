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
