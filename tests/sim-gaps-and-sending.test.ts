/**
 * Simulated tests of the latest sending changes, end to end through the real send code:
 * random gaps (first emails and follow-ups), tracking off on real Mailgun requests, and the crowded-domain warning.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";
import { crowdedDomains } from "../src/lib/mailbox-crowding.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });
const id = (r: { id?: unknown }) => r.id as string;

test("first emails: the gaps between consecutive sends are not all the same, never below 5 minutes, never above the plan", async () => {
  const client = S.seedClient();
  const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const campaign = S.seedCampaign(cid);
  S.seedMailbox(cid, { daily_send_limit: 30 });
  for (let i = 0; i < 12; i++) S.seedLead(cid, { campaign_id: id(campaign), created_at: new Date(S.now() - S.DAY + i * 1000).toISOString() });
  const times: number[] = [];
  let before = 0;
  for (let tick = 0; tick < 40; tick++) {
    S.setClock(S.T0 + tick * 5 * S.MIN);
    await app.sendBatch.sendBatchForClient(cid);
    if (S.mailer.sent.length > before) { times.push(S.now()); before = S.mailer.sent.length; }
  }
  assert.ok(times.length >= 6, `sent ${times.length}`);
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / S.MIN));
  assert.ok(gaps.every((g) => g >= 5), `a gap under the 5-minute floor: ${gaps}`);
  assert.ok(gaps.every((g) => g <= 15), `a gap above the 15-minute plan: ${gaps}`);
  assert.ok(new Set(gaps).size >= 2, `gaps should vary, got ${gaps}`);
});

test("follow-ups: one client's follow-ups are spaced by varying 3-10 minute gaps, never back to back", async () => {
  const client = S.seedClient();
  const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const mb = S.seedMailbox(cid, { daily_send_limit: 100 });
  for (let i = 0; i < 8; i++) S.seedSentLead(cid, id(mb));
  const times: number[] = [];
  let before = 0;
  for (let tick = 0; tick < 24; tick++) {
    S.setClock(S.T0 + tick * 5 * S.MIN);
    await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: true });
    if (S.mailer.sent.length > before) { times.push(S.now()); before = S.mailer.sent.length; }
  }
  assert.ok(times.length >= 5, `sent ${times.length}`);
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / S.MIN));
  assert.ok(gaps.every((g) => g >= 5 && g <= 10), `gaps outside what the 5-minute cron can produce from a 3-10 minute wait: ${gaps}`);
  assert.ok(new Set(gaps).size >= 2, `gaps should vary, got ${gaps}`);
});

test("the same moment gives the same answer: waiting does not re-roll the dice", async () => {
  const client = S.seedClient();
  const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3 });
  const mb = S.seedMailbox(cid, { daily_send_limit: 100 });
  for (let i = 0; i < 2; i++) S.seedSentLead(cid, id(mb));
  await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: true });
  assert.equal(S.mailer.sent.length, 1);
  // Poll every minute: it must open exactly once, at one fixed moment.
  let openedAt = -1;
  for (let m = 1; m <= 12 && openedAt < 0; m++) {
    S.setClock(S.T0 + m * S.MIN);
    await app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: true });
    if ((S.mailer.sent.length as number) === 2) openedAt = m;
  }
  assert.ok(openedAt >= 3 && openedAt <= 10, `opened after ${openedAt} min`);
});

test("cold emails go out with open/click tracking switched off (real Mailgun request body)", async () => {
  const calls: { url: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  process.env.MAILGUN_API_KEY = "key-test";
  const mod = await import(`../src/lib/mailgun.ts?real=${Date.now()}`);
  globalThis.fetch = (async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url: String(url), body: init.body.toString() });
    return new Response(JSON.stringify({ id: "<x@mg>", message: "Queued" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await mod.sendMail({ domain: "example.com", from: "A <a@example.com>", to: "b@x.test", subject: "Hi", text: "Hello" });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  const p = new URLSearchParams(calls[0].body);
  assert.equal(p.get("o:tracking"), "no");
  assert.equal(p.get("o:tracking-opens"), "no");
  assert.equal(p.get("o:tracking-clicks"), "no");
});

test("a domain with more than 3 mailboxes is flagged as crowded; 3 or fewer is not; other domains are separate", () => {
  const mk = (d: string, n: number) => Array.from({ length: n }, (_, i) => `m${i}@${d}`);
  assert.deepEqual(crowdedDomains([...mk("a.com", 3), ...mk("b.com", 2)]), []);
  assert.deepEqual(crowdedDomains([...mk("a.com", 4), ...mk("b.com", 3)]), [["a.com", 4]]);
  assert.deepEqual(crowdedDomains(mk("TechyWorld.site", 8).concat(["x@techyworld.site"])), [["techyworld.site", 9]], "case-insensitive");
});
