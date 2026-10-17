/** QA: a failure AFTER Mailgun accepted the first email must not release the slot or re-send the lead (defect D-1 probe). */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });
const id = (r: { id?: unknown }) => r.id as string;

test("D-1: exception after sendMail must not leave the lead new (would be emailed again next run)", async () => {
  const client = S.seedClient(); const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const camp = S.seedCampaign(cid);
  S.seedMailbox(cid, { daily_send_limit: 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() });
  const lead = S.seedLead(cid, { campaign_id: id(camp), created_at: new Date(S.now() - S.DAY).toISOString() });
  // Make the post-send lead update throw once (e.g. network drop after Mailgun accepted the mail).
  const realFrom = S.db.from.bind(S.db);
  let armed = true;
  (S.db as any).from = (t: string) => {
    const q = realFrom(t);
    if (t === "leads" && q.update) {
      const u = q.update.bind(q);
      q.update = (v: any) => { if (armed && v?.status === "email_sent") { armed = false; throw new Error("simulated network drop after send"); } return u(v); };
    }
    return q;
  };
  await app.sendBatch.sendBatchForClient(cid);
  (S.db as any).from = realFrom;
  const mails = S.mailer.sent.length;
  const l = S.leadRow(id(lead));
  assert.equal(mails, 1, "one email went out");
  assert.notEqual(l.status, "new", `lead still '${l.status}' after its email was sent -> it would be emailed again`);
});
