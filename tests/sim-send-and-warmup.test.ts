/**
 * Simulated tests of first-email sending (sendBatchForClient), warm-up in real use, pacing windows and
 * deliverability gates. Real code, fake database + mailer + AI (tests/helpers/sim.ts). No network.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as S from "./helpers/sim.ts";
import { lintOutreachEmail } from "../src/lib/email-quality.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
let app: App;
before(async () => { S.startClock(); app = await S.loadApp(); });
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); });

const id = (r: { id?: unknown }) => r.id as string;
const send = (cid: string) => app.sendBatch.sendBatchForClient(cid);
type Sent = { result: string; detail?: string; sent?: { result: string; error?: string }[] };

/** One client with an active campaign, a job, `mailboxes` mailboxes and `leads` brand-new eligible leads. */
function world(o: { mailboxes?: number; limit?: number; ageDays?: number; leads?: number; client?: Record<string, unknown>; criteria?: Record<string, unknown> } = {}) {
  const client = S.seedClient(o.client);
  const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 3, ...(o.criteria ?? {}) });
  const campaign = S.seedCampaign(cid);
  const mailboxes = Array.from({ length: o.mailboxes ?? 1 }, (_, i) =>
    S.seedMailbox(cid, { daily_send_limit: o.limit ?? 30, created_at: new Date(S.now() - (o.ageDays ?? 10) * S.DAY + i).toISOString() }));
  const leads = Array.from({ length: o.leads ?? 1 }, (_, i) =>
    S.seedLead(cid, { campaign_id: id(campaign), created_at: new Date(S.now() - S.DAY + i * 1000).toISOString() }));
  return { client, cid, campaign, mailboxes, leads };
}

// ------------------------------------------------------------------ happy path
test("sends one first email and records everything a follow-up will need", async () => {
  const w = world({ criteria: { follow_up_delay_days: 0.01 } });
  const r = (await send(w.cid)) as Sent;
  assert.equal(r.result, "processed");
  assert.equal(S.mailer.sent.length, 1);
  const mail = S.mailer.sent[0];
  assert.equal(mail.to, w.leads[0].email);
  assert.ok(mail.from.startsWith("Test Co <"), "display name = the client's company");
  assert.match(mail.text, /Reply "STOP"/);
  assert.ok(mail.headers?.["List-Unsubscribe"]);
  assert.equal(mail.inReplyTo, undefined, "a first email is not a reply");
  assert.deepEqual(lintOutreachEmail({ subject: mail.subject, body: mail.text.split("\n--\n")[0] }), [], "passes the deliverability checks");

  const lead = S.leadRow(id(w.leads[0]));
  assert.equal(lead.status, "email_sent");
  assert.equal(lead.follow_up_number, 1);
  assert.equal(Math.round((Date.parse(lead.next_follow_up_at) - S.T0) / S.MIN), 14, "first follow-up due after the configured delay (0.01 day)");
  const log = S.realLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].touch_number, 1);
  assert.equal(log[0].mailbox_id, id(w.mailboxes[0]));
  assert.equal(log[0].provider_message_id, mail.id);
  assert.equal(log[0].subject, mail.subject);
  assert.equal(S.pendingLog().length, 0);
  assert.equal(S.db.all("campaigns")[0].sent_count, 1);
});

test("exactly one lead per run, oldest first", async () => {
  const w = world({ leads: 3 });
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 1);
  assert.equal(S.mailer.sent[0].to, w.leads[0].email);
});

test("the pacing gap is enforced between sends, then the next lead goes out", async () => {
  const w = world({ leads: 3 });
  await send(w.cid);
  S.setClock(S.T0 + 3 * S.MIN);
  assert.match(((await send(w.cid)) as Sent).detail!, /waiting for the planned \d+-minute gap/);
  assert.equal(S.mailer.sent.length, 1);
  S.setClock(S.T0 + 16 * S.MIN);
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 2);
  assert.equal(S.mailer.sent[1].to, w.leads[1].email);
});

test("the first email and its follow-ups end up as one conversation (end to end)", async () => {
  const w = world({ criteria: { follow_up_delay_days: 0.01 } });
  await send(w.cid);
  const first = S.mailer.sent[0];
  S.setClock(S.T0 + 16 * S.MIN);
  await app.followUps.runFollowUpBatch({ clientIdFilter: w.cid, isCron: false });
  const fu = S.mailer.sent[1];
  assert.equal(fu.subject, first.subject);
  assert.equal(fu.inReplyTo, first.id);
  assert.ok(fu.from.includes(w.mailboxes[0].address as string));
  assert.equal(S.leadRow(id(w.leads[0])).follow_up_number, 2);
});

// ------------------------------------------------------------------ who may be emailed
test("only active, eligible leads are emailed", async () => {
  const w = world({ leads: 0 });
  const camp = id(w.campaign);
  const bad = {
    unsubscribed: S.seedLead(w.cid, { campaign_id: camp, unsubscribed: true }),
    bounced: S.seedLead(w.cid, { campaign_id: camp, email_bounced: true }),
    booked: S.seedLead(w.cid, { campaign_id: camp, booked: true }),
    complained: S.seedLead(w.cid, { campaign_id: camp, complained: true }),
    stopped: S.seedLead(w.cid, { campaign_id: camp, manually_stopped: true }),
    alreadyEmailed: S.seedLead(w.cid, { campaign_id: camp, status: "email_sent" }),
    manuallyAdded: S.seedLead(w.cid, { campaign_id: camp, lead_source: "manual" }),
    otherCampaign: S.seedLead(w.cid, { campaign_id: "some-other-campaign" }),
    noEmail: S.seedLead(w.cid, { campaign_id: camp, email: null }),
  };
  const otherClient = S.seedClient();
  const foreign = S.seedLead(id(otherClient), { campaign_id: id(S.seedCampaign(id(otherClient))) });
  const r = (await send(w.cid)) as Sent;
  assert.equal(S.mailer.sent.map((m) => Object.entries(bad).find(([, l]) => l.email === m.to)?.[0] ?? m.to).join(","), "", "emailed an ineligible lead");
  assert.equal(r.detail, "no eligible leads");
  assert.equal(S.mailer.sent.length, 0);
  assert.equal(Object.keys(bad).length, 9);
  assert.equal(S.leadRow(id(foreign)).status, "new", "another client's lead was not touched");
});

// ------------------------------------------------------------------ guards that stop a send
test("skips (and says why) when there is nothing it may send", async () => {
  // no active campaign
  let w = world();
  S.db.rows("campaigns")[0].status = "paused";
  assert.equal(((await send(w.cid)) as Sent).detail, "no active campaign this month");
  // no timezone
  S.resetWorld(); w = world({ client: { timezone: null } });
  assert.match(((await send(w.cid)) as Sent).detail!, /timezone not set/);
  // no mailbox
  S.resetWorld(); w = world({ mailboxes: 0 });
  assert.match(((await send(w.cid)) as Sent).detail!, /no mailbox/);
  // no saved outreach description
  S.resetWorld(); w = world({ criteria: { what_you_sell: "" } });
  assert.match(((await send(w.cid)) as Sent).detail!, /what_you_sell/);
  // Mailgun domain not verified
  S.resetWorld(); w = world();
  S.mailer.readiness.set((w.mailboxes[0].address as string).split("@")[1], "verifying");
  assert.match(((await send(w.cid)) as Sent).detail!, /not ready/);
  assert.equal(S.mailer.sent.length, 0);
});

test("a domain owned by another client or disconnected is never sent from", async () => {
  for (const kind of ["owned_by_other", "disconnected"]) {
    S.resetWorld(); S.setClock(S.T0);
    const w = world();
    const domain = (w.mailboxes[0].address as string).split("@")[1];
    if (kind === "owned_by_other") S.db.rows("domain_ownership").push({ domain, client_id: id(S.seedClient()) });
    else S.db.rows("domains").push({ client_id: w.cid, domain, dns_status: "disconnected" });
    const r = (await send(w.cid)) as Sent;
    assert.match(r.sent![0].error!, /not usable/, kind);
    assert.equal(S.mailer.sent.length, 0);
    assert.equal(S.pendingLog().length, 0);
    assert.equal(S.leadRow(id(w.leads[0])).status, "new", "lead untouched");
  }
});

test("a lead already claimed by another run is not emailed twice", async () => {
  const w = world();
  const [a, b] = await Promise.all([send(w.cid), send(w.cid)]);
  assert.equal(S.mailer.sent.length, 1);
  assert.ok(a && b);
  assert.equal(S.realLog().length, 1);
});

// ------------------------------------------------------------------ failures
test("a mailer failure leaves the lead untouched and uncounted, and the next run sends it once", async () => {
  const w = world();
  S.mailer.failTimes = 1;
  const r = (await send(w.cid)) as Sent;
  assert.equal(r.sent![0].result, "failed");
  assert.match(r.sent![0].error!, /Mailgun 500/);
  const lead = S.leadRow(id(w.leads[0]));
  assert.equal(lead.status, "new");
  assert.equal(lead.last_contact_at, null);
  assert.equal(lead.follow_up_number, null);
  assert.equal(S.db.all("outreach_log").length, 0, "no log row, no leaked reservation");
  assert.equal(S.db.all("campaigns")[0].sent_count, 0);

  S.setClock(S.T0 + 16 * S.MIN);
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 1);
  assert.equal(S.leadRow(id(w.leads[0])).follow_up_number, 1);
});

// ------------------------------------------------------------------ draft selection and deliverability gates
test("AI draft is used when it passes the deliverability checks", async () => {
  const w = world();
  await send(w.cid);
  assert.equal(S.mailer.sent[0].subject, S.ai.aidaSubject);
  assert.equal(S.ai.aidaCalls.length, 1);
  assert.equal(S.ai.aidaCalls[0].leadCompany, "Acme Realty");
  assert.ok(w);
});

test("if the AI is down the fixed template goes out instead, and it is safe to send", async () => {
  const w = world();
  S.ai.aidaFails = true;
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 1);
  const body = S.mailer.sent[0].text.split("\n--\n")[0];
  assert.match(body, /^Hi Sam,/);
  assert.deepEqual(lintOutreachEmail({ subject: S.mailer.sent[0].subject, body }), []);
  assert.ok(S.words(body) <= 150);
});

test("an AI draft that fails the spam/length checks is replaced by the fixed template", async () => {
  for (const bad of [
    "Hi Sam,\n\nThis is a guaranteed way to double your leads, free of charge. Act now and click here to see more about how we help every agency grow quickly with automation today.\n\nBest,\nTest Co",
    "Hi Sam. Quick one.",
    `Hi Sam,\n\n${"We help agencies reply faster to every enquiry. ".repeat(30)}\n\nBest,\nTest Co`,
    "Hi Sam,\n\nHave a look at https://example.com/offer to see how we help agencies reply faster to every single enquiry they receive each day.\n\nBest,\nTest Co",
  ]) {
    S.resetWorld(); S.setClock(S.T0);
    const w = world();
    S.ai.aidaBody = bad;
    await send(w.cid);
    assert.equal(S.mailer.sent.length, 1);
    const body = S.mailer.sent[0].text.split("\n--\n")[0];
    assert.notEqual(body.trim(), bad.trim(), "the bad draft was not sent");
    assert.deepEqual(lintOutreachEmail({ subject: S.mailer.sent[0].subject, body }), [], "what went out is clean");
  }
});

test("last safety gate: if even the fallback template would trip the spam checks, nothing is sent and the lead stays untouched", async () => {
  const w = world({ leads: 0 });
  const spammy = S.seedLead(w.cid, { campaign_id: id(w.campaign), company: "Free Cash Winners Ltd" });
  S.ai.aidaFails = true;
  const r = (await send(w.cid)) as Sent;
  assert.equal(S.mailer.sent.length, 0);
  assert.match(r.sent![0].error!, /Draft failed deliverability checks/);
  assert.equal(S.leadRow(id(spammy)).status, "new");
  assert.equal(S.leadRow(id(spammy)).last_contact_at, null);
  assert.equal(S.db.all("outreach_log").length, 0);
});

test("CURRENT BEHAVIOUR: a client's saved template overrides the AI draft for every new lead (the 'food businesses' mismatch)", async () => {
  const w = world({ client: { outreach_template_subject: "Quick question for {first_name} at {company}", outreach_template_body: "Hi {first_name},\n\nI came across {company} and wanted to reach out quickly.\n\nWe help food businesses like yours automate customer follow-ups and marketing, saving hours every week.\n\nWorth a quick 15-minute chat?\n\nBest,\n{sender_company}" } });
  await send(w.cid);
  const mail = S.mailer.sent[0];
  assert.equal(mail.subject, "Quick question for Sam at Acme Realty", "first name only");
  assert.match(mail.text, /food businesses/, "the stale saved template wins over the AI text");
});

test("an unusable saved template (fails lint) falls back to the AI draft", async () => {
  const w = world({ client: { outreach_template_subject: "FREE offer!!", outreach_template_body: "Hi {first_name}, this is free, act now." } });
  await send(w.cid);
  assert.equal(S.mailer.sent[0].subject, S.ai.aidaSubject);
});

// ------------------------------------------------------------------ daily limit, cap, warm-up in real use
test("warm-up: a brand-new mailbox saved at 30/day sends only what its age allows, and the rest waits", async () => {
  const w = world({ limit: 30, ageDays: 0, leads: 8 });
  const allowed = app.warmup.coldLimitForAge(0);
  assert.ok(allowed < 30);
  for (let i = 0; i < allowed; i++) { S.setClock(S.T0 + i * 16 * S.MIN); await send(w.cid); }
  assert.equal(S.mailer.sent.length, allowed);
  S.setClock(S.T0 + allowed * 16 * S.MIN);
  assert.equal(((await send(w.cid)) as Sent).detail, "daily limit already reached");
  assert.equal(S.mailer.sent.length, allowed, "the warm-up ceiling held even though 30 was saved");
});

test("a low limit saved on a warming mailbox is what blocks sending (the 3/3 case)", async () => {
  const w = world({ limit: 3, ageDays: 6, leads: 6 });
  for (let i = 0; i < 3; i++) { S.setClock(S.T0 + i * 16 * S.MIN); await send(w.cid); }
  S.setClock(S.T0 + 3 * 16 * S.MIN);
  assert.equal(((await send(w.cid)) as Sent).detail, "daily limit already reached");
  assert.equal(S.mailer.sent.length, 3);
  const d = app.warmup.describeMailboxLimit({ daily_send_limit: 3, created_at: w.mailboxes[0].created_at as string });
  assert.equal(d.limitedBy, "configured");
});

test("the limit resets the next day", async () => {
  const w = world({ limit: 3, ageDays: 6, leads: 6 });
  for (let i = 0; i < 3; i++) { S.setClock(S.T0 + i * 16 * S.MIN); await send(w.cid); }
  S.setClock(S.T0 + 24 * S.HOUR);
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 4);
});

test("a client-wide daily cap lower than the mailboxes' capacity is honoured", async () => {
  const w = world({ client: { daily_send_cap: 2 }, leads: 5 });
  for (let i = 0; i < 4; i++) { S.setClock(S.T0 + i * 16 * S.MIN); await send(w.cid); }
  assert.equal(S.mailer.sent.length, 2);
});

test("an unhealthy mailbox (high bounces) is paused; a new first email is not sent from it", async () => {
  const w = world({ leads: 1 });
  const mb = id(w.mailboxes[0]);
  for (let i = 0; i < 20; i++) {
    const l = S.seedLead(w.cid, { email_bounced: i < 5 });
    S.db.rows("outreach_log").push({ id: S.uid("log"), client_id: w.cid, lead_id: l.id, mailbox_id: mb, touch_number: 1, subject: "x", body: "y", provider_message_id: S.uid("<m"), sent_at: new Date(S.T0 - 20 * S.MIN).toISOString() });
  }
  const r = (await send(w.cid)) as Sent;
  assert.equal(S.mailer.sent.length, 0);
  assert.ok(r.sent?.[0]?.error ?? r.detail, "reports why");
});

// ------------------------------------------------------------------ mailbox blocks (windows)
test("with two mailboxes only the one whose block is running sends; breaks and out-of-window send nothing", async () => {
  const w = world({ mailboxes: 2, leads: 6 });
  await send(w.cid);
  assert.ok(S.mailer.sent[0].from.includes(w.mailboxes[0].address as string), "first block = first mailbox");
  S.setClock(Date.UTC(2026, 9, 14, 12, 45)); // two 10-day-old mailboxes allow 17/day each: block 1 is 08:00-12:15, block 2 starts 13:15, so this is the 1h break
  assert.match(((await send(w.cid)) as Sent).detail!, /not inside a mailbox block/);
  S.setClock(Date.UTC(2026, 9, 14, 14, 0)); // block 2
  await send(w.cid);
  assert.ok(S.mailer.sent[1].from.includes(w.mailboxes[1].address as string), "second block = second mailbox");
  assert.equal(S.mailer.sent.length, 2);
});

test("a custom send window is respected (nothing before it starts)", async () => {
  const w = world({ client: { outreach_send_start: "10:00", outreach_send_end: "18:00" } });
  assert.match(((await send(w.cid)) as Sent).detail!, /not inside a mailbox block/); // 08:10 UTC
  S.setClock(Date.UTC(2026, 9, 14, 10, 30));
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 1);
});

test("the client's timezone decides the window (a New York client at 08:10 UTC is not yet in its 09:00 window)", async () => {
  const w = world({ client: { timezone: "America/New_York", outreach_send_start: "09:00", outreach_send_end: "17:00" } });
  assert.match(((await send(w.cid)) as Sent).detail!, /not inside a mailbox block/); // 04:10 in New York
  S.setClock(Date.UTC(2026, 9, 14, 13, 30)); // 09:30 in New York
  await send(w.cid);
  assert.equal(S.mailer.sent.length, 1);
});
