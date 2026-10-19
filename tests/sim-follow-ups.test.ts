/**
 * Simulated tests of the follow-up engine: the real runFollowUpBatch / reserveMailboxSlot code against a fake
 * database and a fake mailer. See tests/helpers/sim.ts. No network, no real email.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });

const run = (clientId: string) => app.followUps.runFollowUpBatch({ clientIdFilter: clientId, isCron: false });
const id = (r: { id?: unknown }) => r.id as string;

function world(over: { limit?: number; criteria?: Record<string, unknown>; mailboxes?: number } = {}) {
  const client = S.seedClient();
  S.seedJob(id(client), over.criteria ?? {});
  const mailboxes = Array.from({ length: over.mailboxes ?? 1 }, () => S.seedMailbox(id(client), { daily_send_limit: over.limit ?? 30, created_at: new Date(S.now() - 10 * S.DAY).toISOString() }));
  return { client, cid: id(client), mailboxes, mb: mailboxes[0], mbId: id(mailboxes[0]) };
}

// ------------------------------------------------------------------ the sequence
test("a due follow-up goes out from the SAME mailbox, in the SAME thread, with the unsubscribe footer", async () => {
  const w = world({ mailboxes: 2 });
  const lead = S.seedSentLead(w.cid, id(w.mailboxes[1]), { subject: "Faster follow-ups for agents", messageId: "<first-1@mg.test>" });
  const r = await run(w.cid);
  assert.deepEqual(r.results.map((x) => x.result), ["sent"]);
  assert.equal(S.mailer.sent.length, 1);
  const mail = S.mailer.sent[0];
  assert.ok(mail.from.includes(w.mailboxes[1].address as string), "sent from the mailbox that sent the first email");
  assert.equal(mail.to, lead.email);
  assert.equal(mail.subject, "Faster follow-ups for agents", "same subject as the first email, not the AI's subject, and no Re:");
  assert.equal(mail.inReplyTo, "<first-1@mg.test>", "threaded onto the first email");
  assert.match(mail.text, /Reply "STOP"/);
  assert.match(mail.text, /Test Co · 1 Test Street, Testville/);
  assert.ok(mail.headers?.["List-Unsubscribe"]);
  const l = S.leadRow(id(lead));
  assert.equal(l.follow_up_number, 2);
  assert.equal(l.status, "follow_up_1");
  const log = S.logFor(id(lead)).sort((a, b) => a.touch_number - b.touch_number);
  assert.deepEqual(log.map((x) => x.touch_number), [1, 2]);
  assert.equal(log[1].mailbox_id, id(w.mailboxes[1]));
  assert.equal(log[1].provider_message_id, mail.id, "reservation finalized with the real message id");
  assert.equal(S.pendingLog().length, 0);
});

test("full sequence: 3 follow-ups on schedule, threaded as a chain, last one is the closing note, then it stops", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId, { messageId: "<first@mg.test>" });
  await run(w.cid);
  assert.equal(S.mailer.sent.length, 1);

  // Not due yet: nothing happens.
  S.setClock(S.T0 + 5 * S.MIN);
  assert.equal((await run(w.cid)).results.length, 0);

  S.setClock(S.T0 + 16 * S.MIN);
  await run(w.cid);
  S.setClock(S.T0 + 32 * S.MIN);
  await run(w.cid);
  assert.equal(S.mailer.sent.length, 3);

  const l = S.leadRow(id(lead));
  assert.equal(l.follow_up_number, 4);
  assert.equal(l.status, "follow_up_3");
  assert.equal(l.next_follow_up_at, null, "nothing scheduled after the last follow-up");

  assert.deepEqual(S.mailer.sent.map((m) => m.inReplyTo), ["<first@mg.test>", S.mailer.sent[0].id, S.mailer.sent[1].id]);
  assert.equal(new Set(S.mailer.sent.map((m) => m.subject)).size, 1, "one subject for the whole thread");
  assert.deepEqual(S.logFor(id(lead)).map((x) => x.touch_number).sort(), [1, 2, 3, 4]);
  assert.equal(new Set(S.logFor(id(lead)).map((x) => x.mailbox_id)).size, 1, "every touch from one mailbox");

  // What the drafter was asked for each time.
  assert.deepEqual(S.ai.followUpCalls.map((c) => c.followUpNumber), [1, 2, 3]);
  assert.deepEqual(S.ai.followUpCalls.map((c) => c.isLastFollowUp), [false, false, true]);
  assert.deepEqual(S.ai.followUpCalls.map((c) => (c.previousEmails as unknown[]).length), [1, 2, 3], "each draft sees every earlier email so it can avoid repeating them");

  // A day later nothing more is ever sent.
  S.setClock(S.T0 + 26 * S.HOUR);
  assert.equal((await run(w.cid)).results.length, 0);
  assert.equal(S.mailer.sent.length, 3);
});

test("the client's follow-up setting is respected; '5 follow-ups' is held to the system maximum of 3", async () => {
  for (const [setting, expected] of [["no follow-up", 0], ["1 follow-up", 1], ["2 follow-ups", 2], ["3 follow-ups", 3], ["5 follow-ups", 3]] as const) {
    S.resetWorld(); S.setClock(S.T0);
    const w = world({ criteria: { follow_ups: setting, follow_up_delay_days: 0.01 } });
    S.seedSentLead(w.cid, w.mbId);
    for (let i = 0; i < 6; i++) { await run(w.cid); S.setClock(S.T0 + (i + 1) * 20 * S.MIN); }
    assert.equal(S.mailer.sent.length, expected, `setting "${setting}"`);
  }
});

test("the first follow-up waits the configured delay after the first email", async () => {
  const w = world({ criteria: { follow_up_delay_days: 3 } });
  const lead = S.seedSentLead(w.cid, w.mbId);
  await run(w.cid);
  const next = Date.parse(S.leadRow(id(lead)).next_follow_up_at);
  assert.equal(Math.round((next - S.T0) / S.HOUR), 72, "3 days");
});

// ------------------------------------------------------------------ who must never get a follow-up
for (const flag of ["reply_received", "unsubscribed", "email_bounced", "booked", "complained", "manually_stopped"]) {
  test(`no follow-up once the lead is flagged ${flag}`, async () => {
    const w = world();
    const lead = S.seedSentLead(w.cid, w.mbId, { lead: { [flag]: true } });
    const r = await run(w.cid);
    assert.equal(r.results.length, 0);
    assert.equal(S.mailer.sent.length, 0);
    assert.equal(S.leadRow(id(lead)).follow_up_number, 1);
  });
}

test("no follow-up for a lead whose first email was never sent, or that is not due yet", async () => {
  const w = world();
  S.seedLead(w.cid, { follow_up_number: null, next_follow_up_at: new Date(S.T0 - S.HOUR).toISOString() });
  S.seedSentLead(w.cid, w.mbId, { dueInMs: 2 * S.HOUR });
  assert.equal((await run(w.cid)).results.length, 0);
  assert.equal(S.mailer.sent.length, 0);
});

test("a follow-up is never sent while a reply/unsub arrives between selecting and claiming (atomic claim)", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  // Two overlapping runs (cron + manual): exactly one email.
  const [a, b] = await Promise.all([run(w.cid), run(w.cid)]);
  assert.equal(S.mailer.sent.length, 1, "overlapping runs never double-send");
  const all = [...a.results, ...b.results].map((x) => x.result).sort();
  assert.deepEqual(all, ["sent", "skipped"]);
  assert.equal(S.leadRow(id(lead)).follow_up_number, 2);
});

// ------------------------------------------------------------------ same-mailbox rule
test("a follow-up WAITS when its mailbox is at its daily limit; it never switches to another mailbox", async () => {
  const w = world({ mailboxes: 2, limit: 3 });
  const lead = S.seedSentLead(w.cid, w.mbId, { dueInMs: -S.MIN });
  const due = S.leadRow(id(lead)).next_follow_up_at;
  // Fill the pinned mailbox to its limit with other leads' emails today (the lead's own first email is one of the 3).
  for (let i = 0; i < 2; i++) S.seedSentLead(w.cid, w.mbId, { dueInMs: 3 * S.DAY });
  const r = await run(w.cid);
  assert.equal(r.results[0].result, "skipped");
  assert.match(r.results[0].detail!, /daily limit reached.*never switch/);
  assert.equal(S.mailer.sent.length, 0, "the other mailbox was NOT used");
  assert.equal(S.leadRow(id(lead)).next_follow_up_at, due, "still due exactly as before");
  assert.equal(S.pendingLog().length, 0, "no leaked reservation");

  // Next day the limit resets and the same mailbox sends it.
  S.setClock(S.T0 + 24 * S.HOUR);
  const r2 = await run(w.cid);
  assert.equal(r2.results.find((x) => x.leadId === id(lead))?.result, "sent");
  assert.ok(S.mailer.sent[0].from.includes(w.mb.address as string));
});

test("a follow-up waits when its mailbox is paused for a high bounce rate (and goes out when it recovers)", async () => {
  const w = world({ mailboxes: 2 });
  const lead = S.seedSentLead(w.cid, w.mbId);
  // 20 recent sends from the pinned mailbox, 5 bounced = 25% > 8%.
  for (let i = 0; i < 20; i++) {
    const l = S.seedLead(w.cid, { email_bounced: i < 5, status: "email_sent", follow_up_number: 1 });
    S.db.rows("outreach_log").push({ id: S.uid("log"), client_id: w.cid, lead_id: l.id, mailbox_id: w.mbId, touch_number: 1, subject: "x", body: "y", provider_message_id: S.uid("<m"), sent_at: new Date(S.T0 - 30 * S.MIN).toISOString() });
  }
  const r = await run(w.cid);
  assert.match(r.results.find((x) => x.leadId === id(lead))!.detail!, /paused: high bounce\/complaint rate/);
  assert.equal(S.mailer.sent.length, 0);
});

test("a follow-up waits when Mailgun says the mailbox's domain is not ready", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  S.mailer.readiness.set((w.mb.address as string).split("@")[1], "verifying");
  const r = await run(w.cid);
  assert.match(r.results[0].detail!, /not ready/);
  assert.equal(S.mailer.sent.length, 0);
  assert.ok(S.leadRow(id(lead)).next_follow_up_at, "still queued");
});

test("a lead whose original mailbox is unknown is held (24h), never sent from a guess", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  S.db.rows("outreach_log").length = 0; // first email log lost
  const r = await run(w.cid);
  assert.match(r.results[0].detail!, /original mailbox is unknown/);
  assert.equal(S.mailer.sent.length, 0);
  const next = Date.parse(S.leadRow(id(lead)).next_follow_up_at);
  assert.equal(Math.round((next - S.T0) / S.HOUR), 24);
});

test("a domain owned by another client, or disconnected, blocks the follow-up and releases the slot", async () => {
  for (const kind of ["owned_by_other", "disconnected"]) {
    S.resetWorld(); S.setClock(S.T0);
    const w = world();
    const other = S.seedClient();
    const domain = (w.mb.address as string).split("@")[1];
    if (kind === "owned_by_other") S.db.rows("domain_ownership").push({ domain, client_id: id(other) });
    else S.db.rows("domains").push({ client_id: w.cid, domain, dns_status: "disconnected" });
    const lead = S.seedSentLead(w.cid, w.mbId);
    const r = await run(w.cid);
    assert.equal(r.results[0].result, "error", kind);
    assert.match(r.results[0].detail!, /not usable/);
    assert.equal(S.mailer.sent.length, 0);
    assert.equal(S.pendingLog().length, 0, "slot released");
    assert.ok(S.leadRow(id(lead)).next_follow_up_at, "still in the sequence");
  }
});

test("a lead with no saved outreach description is held for a day, not dropped", async () => {
  const w = world({ criteria: { what_you_sell: "" } });
  const lead = S.seedSentLead(w.cid, w.mbId);
  const r = await run(w.cid);
  assert.match(r.results[0].detail!, /what_you_sell/);
  assert.equal(S.mailer.sent.length, 0);
  assert.ok(S.leadRow(id(lead)).next_follow_up_at);
});

// ------------------------------------------------------------------ failures
test("mailer failure: nothing is recorded as sent, the slot is released, the lead retries in an hour and is sent exactly once", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  S.mailer.failTimes = 1;
  const r = await run(w.cid);
  assert.equal(r.results[0].result, "error");
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(S.pendingLog().length, 0);
  assert.equal(S.leadRow(id(lead)).follow_up_number, 1, "sequence position unchanged");
  assert.equal(S.logFor(id(lead)).length, 1, "only the first email is logged");
  assert.equal(Math.round((Date.parse(S.leadRow(id(lead)).next_follow_up_at) - S.T0) / S.MIN), 60);

  assert.equal((await run(w.cid)).results.length, 0, "not retried before the hour");
  S.setClock(S.T0 + 61 * S.MIN);
  assert.deepEqual((await run(w.cid)).results.map((x) => x.result), ["sent"]);
  assert.equal(S.mailer.sent.length, 1);
  assert.equal(S.leadRow(id(lead)).follow_up_number, 2);
});

test("AI drafting failure behaves the same: no send, no leak, retry later", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  S.ai.followUpFailTimes = 1;
  const r = await run(w.cid);
  assert.equal(r.results[0].result, "error");
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(S.pendingLog().length, 0);
  assert.ok(S.leadRow(id(lead)).next_follow_up_at);
});

// ------------------------------------------------------------------ capacity and priority
test("follow-ups count toward the mailbox's daily limit (first emails + follow-ups share it)", async () => {
  const w = world({ limit: 3 });
  const a = S.seedSentLead(w.cid, w.mbId, { dueInMs: -2 * S.MIN });
  const b = S.seedSentLead(w.cid, w.mbId, { dueInMs: -S.MIN });
  const c = S.seedSentLead(w.cid, w.mbId, { dueInMs: 0 });
  // Their three first emails already used 3/3 today -> no follow-up can go out, all wait.
  const r = await run(w.cid);
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(r.results.filter((x) => x.result === "skipped").length, 3);
  for (const l of [a, b, c]) assert.ok(S.leadRow(id(l)).next_follow_up_at);
});

test("new first emails leave room for follow-ups that are due on the same mailbox", async () => {
  const w = world({ limit: 3 });
  // Two earlier leads already emailed today from this mailbox; their follow-ups are due later today.
  S.seedSentLead(w.cid, w.mbId, { dueInMs: 2 * S.HOUR });
  S.seedSentLead(w.cid, w.mbId, { dueInMs: 3 * S.HOUR });
  const fresh = S.seedLead(w.cid);
  // 2 used + 2 follow-ups waiting >= limit 3: a NEW email must be refused ...
  const newEmail = await app.readiness.reserveMailboxSlot(S.db as never, w.cid, id(fresh), { touch_number: 1 }, { mailboxId: w.mbId });
  assert.equal(newEmail.ok, false);
  // ... but a follow-up (touch 2) for a lead pinned to it still gets the remaining slot.
  const followUp = await app.readiness.reserveMailboxSlot(S.db as never, w.cid, id(fresh), { touch_number: 2 }, { mailboxId: w.mbId });
  assert.equal(followUp.ok, true);
});

test("follow-ups due only TOMORROW do not hold back today's new emails", async () => {
  const w = world({ limit: 3 });
  S.seedSentLead(w.cid, w.mbId, { dueInMs: 30 * S.HOUR });
  const fresh = S.seedLead(w.cid);
  const r = await app.readiness.reserveMailboxSlot(S.db as never, w.cid, id(fresh), { touch_number: 1 }, { mailboxId: w.mbId });
  assert.equal(r.ok, true);
});

test("follow-ups due on a DIFFERENT mailbox do not hold back this mailbox's new emails", async () => {
  const w = world({ limit: 3, mailboxes: 2 });
  for (let i = 0; i < 3; i++) S.seedSentLead(w.cid, id(w.mailboxes[1]), { dueInMs: 2 * S.HOUR });
  const fresh = S.seedLead(w.cid);
  const r = await app.readiness.reserveMailboxSlot(S.db as never, w.cid, id(fresh), { touch_number: 1 }, { mailboxId: w.mbId });
  assert.equal(r.ok, true);
});

test("the daily limit is never exceeded even when many sends race for the last slots", async () => {
  const w = world({ limit: 4 });
  const leads = Array.from({ length: 12 }, () => S.seedLead(w.cid));
  const results = await Promise.all(leads.map((l) => app.readiness.reserveMailboxSlot(S.db as never, w.cid, id(l), { touch_number: 1 }, { mailboxId: w.mbId })));
  const ok = results.filter((r) => r.ok).length;
  assert.ok(ok <= 4, `granted ${ok} of a limit of 4`);
  assert.ok(ok >= 1);
  assert.equal(S.pendingLog().length, ok, "no stray reservation rows for the refused ones");
});

// ------------------------------------------------------------------ multi-tenant
test("cron mode: each client is capped per run, each lead is served only from its own client's mailbox", async () => {
  const A = world({ limit: 100 }), B = world({ limit: 100 });
  const leadsA = Array.from({ length: 7 }, () => S.seedSentLead(A.cid, A.mbId));
  const leadsB = Array.from({ length: 7 }, () => S.seedSentLead(B.cid, B.mbId));
  const r = await app.followUps.runFollowUpBatch({ clientIdFilter: null, isCron: true });
  assert.equal(r.results.filter((x) => x.result === "sent").length, 2, "ONE per client per run: spaced out, and one tenant cannot starve the other");
  const owner = new Map<string, string>([...leadsA.map((l) => [l.email as string, A.cid] as const), ...leadsB.map((l) => [l.email as string, B.cid] as const)]);
  const addr = new Map<string, string>([[A.cid, A.mb.address as string], [B.cid, B.mb.address as string]]);
  for (const m of S.mailer.sent) assert.ok(m.from.includes(addr.get(owner.get(m.to)!)!), "sent from the owning client's own mailbox");
  // The rest go out on the next run.
  S.setClock(S.T0 + 15 * S.MIN);
  const r2 = await app.followUps.runFollowUpBatch({ clientIdFilter: null, isCron: true });
  assert.equal(r2.results.filter((x) => x.result === "sent").length, 2, "a later run (past the random pacing gap) sends one more per client");
});

test("pacing: a client's follow-ups are never sent back-to-back, even in one manual run", async () => {
  const w = world({ limit: 100 });
  [0, 1, 2].forEach(() => S.seedSentLead(w.cid, w.mbId));
  const r = await run(w.cid);
  assert.equal(r.results.filter((x) => x.result === "sent").length, 1, "only the first goes; the rest wait");
  assert.ok(r.results.filter((x) => x.result === "skipped").every((x) => /pacing/.test(x.detail ?? "")));
  S.setClock(S.now() + 15 * S.MIN);
  const r2 = await run(w.cid);
  assert.equal(r2.results.filter((x) => x.result === "sent").length, 1, "after the random gap (max 10 min) the next one goes");
});

test("a manual run for one client never touches another client's leads", async () => {
  const A = world(), B = world();
  S.seedSentLead(A.cid, A.mbId);
  const lb = S.seedSentLead(B.cid, B.mbId);
  await run(A.cid);
  assert.equal(S.mailer.sent.length, 1);
  assert.equal(S.leadRow(id(lb)).follow_up_number, 1);
});

test("oldest-due follow-ups are served first", async () => {
  const w = world();
  const late = S.seedSentLead(w.cid, w.mbId, { dueInMs: -S.MIN });
  const early = S.seedSentLead(w.cid, w.mbId, { dueInMs: -3 * S.HOUR });
  const r = await run(w.cid);
  assert.equal(r.results[0].leadId, id(early));
  assert.equal(r.results[1].leadId, id(late));
});

// ------------------------------------------------------------------ one "today" for every limit
test("the mailbox's daily limit resets at the CLIENT's midnight, not the server's", async () => {
  const client = S.seedClient({ timezone: "Asia/Karachi" }); // UTC+5
  const cid = id(client);
  S.seedJob(cid);
  const mb = S.seedMailbox(cid, { daily_send_limit: 3, created_at: new Date(S.T0 - 6 * S.DAY).toISOString() });
  const fresh = S.seedLead(cid);
  // 23:50 in Karachi on 14 Oct (= 18:50 UTC): the three allowed sends for that Karachi day are already used.
  const lateEvening = Date.UTC(2026, 9, 14, 18, 50);
  for (let i = 0; i < 3; i++) {
    S.db.rows("outreach_log").push({ id: S.uid("log"), client_id: cid, lead_id: S.uid("old"), mailbox_id: id(mb), touch_number: 1, subject: "x", body: "y", provider_message_id: S.uid("<m"), sent_at: new Date(lateEvening - i * S.MIN).toISOString() });
  }
  S.setClock(lateEvening + 5 * S.MIN);
  const blocked = await app.readiness.reserveMailboxSlot(S.db as never, cid, id(fresh), { touch_number: 1 }, { mailboxId: id(mb) });
  assert.equal(blocked.ok, false, "still the same Karachi day");
  // 00:05 in Karachi on 15 Oct (= 19:05 UTC): a new day for this client, although it is still 14 Oct in UTC.
  S.setClock(Date.UTC(2026, 9, 14, 19, 5));
  const fresh2 = await app.readiness.reserveMailboxSlot(S.db as never, cid, id(fresh), { touch_number: 1 }, { mailboxId: id(mb) });
  assert.equal(fresh2.ok, true, "the limit reset at the client's midnight");
});

test("a spammy AI follow-up (\"free\") is never sent: redrafted, then deferred if it keeps failing", async () => {
  const w = world();
  const lead = S.seedSentLead(w.cid, w.mbId);
  S.ai.followUpBody = "Hi Sam, worth a free 15-minute demo this week? Happy to share an example if it helps.";
  const r = await run(w.cid);
  assert.equal(r.results[0].result, "error");
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(S.pendingLog().length, 0);
  assert.ok(S.leadRow(id(lead)).next_follow_up_at);
  assert.ok(S.ai.followUpCalls.length >= 2, "should have tried to redraft");
});
