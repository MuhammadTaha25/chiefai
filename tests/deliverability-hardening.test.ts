/** An undeliverable address is never emailed, and one sending domain cannot exceed its daily cap across mailboxes. */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => { S.stopClock(); delete process.env.DOMAIN_DAILY_SEND_CAP; });
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); delete process.env.DOMAIN_DAILY_SEND_CAP; });
const id = (r: { id?: unknown }) => r.id as string;

test("a lead with a malformed address is not emailed and leaves the queue", async () => {
  const client = S.seedClient(); const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const camp = S.seedCampaign(cid);
  S.seedMailbox(cid, { daily_send_limit: 30 });
  const lead = S.seedLead(cid, { campaign_id: id(camp), email: "not-an-email", created_at: new Date(S.now() - S.DAY).toISOString() });
  await app.sendBatch.sendBatchForClient(cid);
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(S.leadRow(id(lead)).email_bounced, true);
});

test("two mailboxes on one domain share the domain cap", async () => {
  process.env.DOMAIN_DAILY_SEND_CAP = "2";
  const client = S.seedClient(); const cid = id(client);
  const a = S.seedMailbox(cid, { address: "a@shared.test" });
  const b = S.seedMailbox(cid, { address: "b@shared.test" });
  const leads = [0, 1, 2].map(() => S.seedLead(cid));
  const results: boolean[] = [];
  for (const l of leads) {
    const r = await app.readiness.reserveMailboxSlot(S.db as never, cid, id(l), { touch_number: 1 }, {});
    results.push(r.ok);
    if (r.ok) await app.readiness.finalizeReservation(S.db as never, r.reservationId, { messageId: "m", subject: "s", body: "b" });
  }
  assert.deepEqual(results, [true, true, false], `a=${a.id} b=${b.id}`);
});
