/**
 * Simulated tests of the inbound side: Mailgun event webhook (bounce / complaint / unsubscribe), inbound reply
 * webhook (STOP, replies, booking link), and the soft-bounce retry cron. Real route code, fake database and mailer
 * (tests/helpers/sim.ts). No network, no real email.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import * as S from "./helpers/sim.ts";

type App = Awaited<ReturnType<typeof S.loadApp>>;
type Routes = Awaited<ReturnType<typeof S.loadRoutes>>;
let app: App;
let R: Routes;
before(async () => {
  process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
  S.startClock();
  app = await S.loadApp();
  R = await S.loadRoutes();
});
after(() => S.stopClock());
beforeEach(() => { S.resetWorld(); S.setClock(S.T0); process.env.ALLOW_UNSIGNED_WEBHOOKS = "true"; });

const CALENDLY = "https://calendly.com/test-co/30min";
const id = (r: { id?: unknown }) => r.id as string;
let seq = 0;

function world(opts: { calendly?: boolean } = {}) {
  const client = S.seedClient(opts.calendly ? { calendly_url: CALENDLY } : {});
  const cid = id(client);
  S.seedJob(cid, { follow_up_delay_days: 0.01 });
  const campaign = S.seedCampaign(cid);
  const mb = S.seedMailbox(cid);
  const lead = S.seedSentLead(cid, id(mb), { messageId: `<first-${++seq}@mg.test>` });
  const first = S.db.all("outreach_log").find((r) => r.lead_id === lead.id)!;
  return { client, cid, campaign, mb, lead, messageId: first.provider_message_id as string };
}

/** A Mailgun "events" webhook delivery. */
async function mgEvent(over: { event: string; severity?: string; messageId: string; recipient: string; id?: string; reason?: string; status?: unknown }) {
  const body = {
    signature: { timestamp: String(Math.floor(S.now() / 1000)), token: "t", signature: "s" },
    "event-data": {
      event: over.event, id: over.id ?? `ev-${++seq}`, recipient: over.recipient, severity: over.severity, reason: over.reason ?? "bounce",
      timestamp: Math.floor(S.now() / 1000),
      "delivery-status": over.status ?? { code: 550, message: "5.1.1 user unknown" },
      message: { headers: { "message-id": over.messageId.replace(/^<|>$/g, "") } },
    },
  };
  const res = await R.events.POST(new NextRequest("http://localhost/api/webhooks/mailgun/events", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** An inbound reply as Mailgun posts it. */
async function reply(w: ReturnType<typeof world>, text: string, o: { stripped?: string; messageId?: string; sender?: string; headers?: string } = {}) {
  const f = new FormData();
  f.set("timestamp", "1"); f.set("token", "t"); f.set("signature", "s");
  f.set("Message-Id", o.messageId ?? `<in-${++seq}@gmail.test>`);
  f.set("sender", o.sender ?? String(w.lead.email));
  f.set("recipient", String(w.mb.address));
  f.set("body-plain", text);
  f.set("stripped-text", o.stripped ?? text);
  f.set("In-Reply-To", w.messageId);
  f.set("Subject", "Re: Faster follow-ups for agents");
  if (o.headers) f.set("message-headers", o.headers);
  const res = await R.inbound.POST(new NextRequest("http://localhost/api/webhooks/mailgun", { method: "POST", body: f }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const runFollowUps = (cid: string) => app.followUps.runFollowUpBatch({ clientIdFilter: cid, isCron: false });

// ===================================================================== event webhook: authenticity
test("a forged event (no valid signature) is rejected, not trusted", async () => {
  process.env.ALLOW_UNSIGNED_WEBHOOKS = "false";
  delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  const w = world();
  const r = await mgEvent({ event: "failed", severity: "permanent", messageId: w.messageId, recipient: String(w.lead.email) });
  assert.equal(r.status, 401);
  assert.equal(S.leadRow(id(w.lead)).email_bounced, false, "nothing changed");
});

// ===================================================================== hard bounce
test("hard bounce: lead is marked dead, follow-ups cleared, receiver's reason saved, and no follow-up is ever sent", async () => {
  const w = world();
  const r = await mgEvent({ event: "failed", severity: "permanent", messageId: w.messageId, recipient: String(w.lead.email), status: { code: 550, message: "5.1.1 user unknown" } });
  assert.equal(r.status, 200);
  const l = S.leadRow(id(w.lead));
  assert.equal(l.email_bounced, true);
  assert.equal(l.bounce_type, "permanent");
  assert.equal(l.next_follow_up_at, null);
  assert.equal(l.bounce_detail.severity, "permanent");
  assert.deepEqual(l.bounce_detail.delivery_status, { code: 550, message: "5.1.1 user unknown" });
  await runFollowUps(w.cid);
  assert.equal(S.mailer.sent.length, 0, "no email goes to a bounced address");
});

test("the same bounce delivered twice is processed once (Mailgun redelivery is a no-op)", async () => {
  const w = world();
  const first = await mgEvent({ event: "failed", severity: "permanent", messageId: w.messageId, recipient: String(w.lead.email), id: "dup-1" });
  const second = await mgEvent({ event: "failed", severity: "permanent", messageId: w.messageId, recipient: String(w.lead.email), id: "dup-1" });
  assert.equal(first.json.event, "bounced");
  assert.equal(second.json.deduped, true);
});

test("an event about a message we did not send is ignored and touches no lead", async () => {
  const w = world();
  const r = await mgEvent({ event: "failed", severity: "permanent", messageId: "<someone-elses@mg.test>", recipient: String(w.lead.email) });
  assert.equal(r.json.matched_lead, false);
  assert.equal(S.leadRow(id(w.lead)).email_bounced, false);
});

test("a bounce only affects the client whose email produced it, even if another client has the same address", async () => {
  const a = world();
  const other = S.seedClient();
  const twin = S.seedLead(id(other), { email: a.lead.email });
  await mgEvent({ event: "failed", severity: "permanent", messageId: a.messageId, recipient: String(a.lead.email) });
  assert.equal(S.leadRow(id(a.lead)).email_bounced, true);
  assert.equal(S.leadRow(id(twin)).email_bounced, false);
});

// ===================================================================== soft bounce
test("soft bounce: the lead is NOT marked dead; a 24-hour retry time is recorded", async () => {
  const w = world();
  const due = S.leadRow(id(w.lead)).next_follow_up_at;
  await mgEvent({ event: "failed", severity: "temporary", messageId: w.messageId, recipient: String(w.lead.email), reason: "generic", status: { code: 452, message: "4.2.2 mailbox full" } });
  const l = S.leadRow(id(w.lead));
  assert.equal(l.email_bounced, false);
  assert.equal(l.bounce_type, "temporary");
  assert.equal(Math.round((Date.parse(l.bounce_retry_after) - S.now()) / S.HOUR), 24);
  assert.equal(l.next_follow_up_at, due, "follow-up schedule untouched");
  assert.equal(l.bounce_detail.delivery_status.code, 452);
});

test("soft-bounce retry cron: needs the secret, ignores leads not yet due, clears the flag once due and reschedules", async () => {
  process.env.CRON_SECRET = "s3cret";
  const w = world();
  const due = S.leadRow(id(w.lead)).next_follow_up_at;
  await mgEvent({ event: "failed", severity: "temporary", messageId: w.messageId, recipient: String(w.lead.email) });
  const call = (auth?: string) => R.bounceRetry.GET(new NextRequest("http://localhost/api/cron/bounce-retry", { headers: auth ? { authorization: auth } : {} }));
  assert.equal((await call()).status, 401);
  assert.equal((await call("Bearer wrong")).status, 401);
  assert.equal(((await (await call("Bearer s3cret")).json()) as { processed: number }).processed, 0, "not due yet");
  S.setClock(S.T0 + 25 * S.HOUR);
  const out = (await (await call("Bearer s3cret")).json()) as { cleared: number };
  assert.equal(out.cleared, 1);
  const l = S.leadRow(id(w.lead));
  assert.equal(l.bounce_type, null);
  assert.equal(l.bounce_retry_after, null);
  assert.equal(l.next_follow_up_at, due, "the follow-up schedule is not pulled forward");
});

test("soft bounce: follow-ups wait out the 24-hour retry window, then go out; a held lead does not block the client's other leads", async () => {
  process.env.CRON_SECRET = "s3cret";
  const w = world();
  const other = S.seedSentLead(w.cid, id(w.mb));
  await mgEvent({ event: "failed", severity: "temporary", messageId: w.messageId, recipient: String(w.lead.email) });
  await runFollowUps(w.cid);
  assert.equal(S.mailer.sent.length, 1, "only the healthy lead is emailed");
  assert.equal(S.mailer.sent[0].to, other.email);
  S.setClock(S.T0 + 25 * S.HOUR);
  await R.bounceRetry.GET(new NextRequest("http://localhost/x", { headers: { authorization: "Bearer s3cret" } }));
  S.setClock(S.T0 + 26 * S.HOUR);
  await runFollowUps(w.cid);
  assert.ok(S.mailer.sent.some((m) => m.to === w.lead.email), "after the retry window the held lead gets its follow-up");
});

test("soft-bounce retry cron never revives a hard-bounced lead", async () => {
  process.env.CRON_SECRET = "s3cret";
  const w = world();
  S.db.rows("leads").find((l) => l.id === w.lead.id)!.bounce_type = "temporary";
  S.db.rows("leads").find((l) => l.id === w.lead.id)!.bounce_retry_after = new Date(S.now() - S.HOUR).toISOString();
  S.db.rows("leads").find((l) => l.id === w.lead.id)!.email_bounced = true;
  const res = await R.bounceRetry.GET(new NextRequest("http://localhost/x", { headers: { authorization: "Bearer s3cret" } }));
  assert.equal(((await res.json()) as { processed: number }).processed, 0);
});

test("WIRING: every cron route in the app is listed in CRONS.md (an unscheduled cron never runs)", () => {
  const routes: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`, `${rel}/${e.name}`);
      else if (e.name === "route.ts") routes.push(rel);
    }
  };
  walk(new URL("../src/app/api/cron", import.meta.url).pathname, "/api/cron");
  const doc = readFileSync(new URL("../CRONS.md", import.meta.url), "utf8");
  // social-content/[type] is the dynamic route behind the post and story rows.
  const missing = routes.filter((r) => !r.includes("[") && !doc.includes(r));
  // KNOWN GAPS found by this check (2026-10-19): written but not scheduled anywhere (not in CRONS.md, not in the
  // n8n "ChiefAI Scheduled Jobs" workflow). Remove an entry here once it is scheduled; add nothing new to this list.
  const KNOWN_UNSCHEDULED: string[] = [];
  assert.deepEqual(missing.sort(), KNOWN_UNSCHEDULED, "a cron route exists that nothing schedules (or a known gap was fixed: shorten the list)");
});

// ===================================================================== complaint / provider unsubscribe
test("spam complaint: lead flagged and follow-ups stop for good", async () => {
  const w = world();
  await mgEvent({ event: "complained", messageId: w.messageId, recipient: String(w.lead.email) });
  const l = S.leadRow(id(w.lead));
  assert.equal(l.complained, true);
  assert.equal(l.next_follow_up_at, null);
  await runFollowUps(w.cid);
  assert.equal(S.mailer.sent.length, 0);
});

test("provider unsubscribe event: lead flagged and follow-ups stop", async () => {
  const w = world();
  await mgEvent({ event: "unsubscribed", messageId: w.messageId, recipient: String(w.lead.email) });
  assert.equal(S.leadRow(id(w.lead)).unsubscribed, true);
  await runFollowUps(w.cid);
  assert.equal(S.mailer.sent.length, 0);
});

// ===================================================================== STOP / unsubscribe by reply
test("reply STOP: lead unsubscribed, dropped, follow-ups cleared, one confirmation sent in the same thread, nothing else", async () => {
  const w = world();
  S.ai.classification = "ANGRY";
  const r = await reply(w, "STOP");
  assert.equal(r.json.unsubscribed, true);
  const l = S.leadRow(id(w.lead));
  assert.equal(l.unsubscribed, true);
  assert.equal(l.status, "dropped");
  assert.equal(l.next_follow_up_at, null);
  assert.equal(S.mailer.sent.length, 1, "only the confirmation");
  assert.match(S.mailer.sent[0].subject + S.mailer.sent[0].text, /unsubscrib|removed|won't|will not/i);
  assert.ok(S.mailer.sent[0].inReplyTo, "sent as a reply");
  assert.equal(S.mailer.sent[0].to, w.lead.email);
  await runFollowUps(w.cid);
  assert.equal(S.mailer.sent.length, 1, "no follow-up after STOP");
});

test("reply STOP still unsubscribes and confirms when the AI classifier hangs (opt-out never waits on Gemini)", async () => {
  const w = world();
  S.ai.classifyHangs = true;
  const r = await reply(w, "STOP");
  assert.equal(r.json.unsubscribed, true);
  const l = S.leadRow(id(w.lead));
  assert.equal(l.unsubscribed, true);
  assert.equal(l.status, "dropped");
  assert.equal(l.next_follow_up_at, null);
  assert.equal(S.mailer.sent.length, 1, "confirmation still sent");
});

test("other ways people opt out also work (unsubscribe / remove me / stop emailing me)", async () => {
  for (const text of ["Please unsubscribe me", "remove me from your list", "stop emailing me"]) {
    S.resetWorld();
    const w = world();
    await reply(w, text);
    assert.equal(S.leadRow(id(w.lead)).unsubscribed, true, text);
  }
});

test("friendly 'stop' wording is NOT an opt-out: the lead stays active-as-a-reply and gets a normal answer", async () => {
  for (const text of ["Don't stop sending me updates, this is useful", "Can you stop by our office on Friday?"]) {
    S.resetWorld();
    const w = world();
    S.ai.classification = "HAPPY";
    await reply(w, text);
    const l = S.leadRow(id(w.lead));
    assert.equal(l.unsubscribed, false, text);
    assert.equal(l.reply_received, true, text);
    assert.equal(l.next_follow_up_at, null, "a real reply still ends the automatic follow-ups");
    assert.equal(S.mailer.sent.length, 1, "they get a normal reply, not an unsubscribe confirmation");
    assert.doesNotMatch(S.mailer.sent[0].text, /unsubscrib/i);
  }
});

test("the 'Reply STOP' text in OUR quoted footer does not unsubscribe someone who typed something else", async () => {
  const w = world();
  S.ai.classification = "HAPPY";
  await reply(w, `Sounds interesting, tell me more\n\n> --\n> Reply "STOP" to opt out`, { stripped: "Sounds interesting, tell me more" });
  assert.equal(S.leadRow(id(w.lead)).unsubscribed, false);
});

test("a lead that already unsubscribed and replies again is recorded but never emailed", async () => {
  const w = world();
  await reply(w, "unsubscribe");
  const before = S.mailer.sent.length;
  const again = await reply(w, "hello?");
  assert.equal(again.json.already_unsubscribed, true);
  assert.equal(S.mailer.sent.length, before);
});

// ===================================================================== normal replies and booking link
test("any real reply stops the follow-up sequence", async () => {
  const w = world();
  S.ai.classification = "UNCLEAR";
  await reply(w, "What does this cost?");
  const l = S.leadRow(id(w.lead));
  assert.equal(l.reply_received, true);
  assert.equal(l.next_follow_up_at, null);
  assert.equal(l.reply_classification, "UNCLEAR");
});

test("an interested reply (BOOKING) always gets the booking link, even if the AI forgot it, from the mailbox that was written to", async () => {
  const w = world({ calendly: true });
  S.ai.classification = "BOOKING";
  S.ai.replyBody = "Great, happy to set up a call. What time suits you?";
  await reply(w, "Yes, can we talk Tuesday?");
  assert.equal(S.mailer.sent.length, 1);
  assert.ok(S.mailer.sent[0].text.includes(CALENDLY), "link present");
  assert.ok(S.mailer.sent[0].from.includes(String(w.mb.address)), "sent from the mailbox that received the reply");
  assert.ok(S.mailer.sent[0].inReplyTo, "threaded");
  assert.equal(S.leadRow(id(w.lead)).status, "booking");
  const log = S.db.all("outreach_log").filter((r) => r.lead_id === w.lead.id && r.touch_number === 0);
  assert.equal(log.length, 1, "the auto-reply is logged");
});

test("HAPPY gets the link too; the link is not duplicated if the AI already included it", async () => {
  const w = world({ calendly: true });
  S.ai.classification = "HAPPY";
  S.ai.replyBody = `Glad you like it. You can pick a time here: ${CALENDLY}`;
  await reply(w, "This looks great, tell me more!");
  assert.equal(S.mailer.sent[0].text.split(CALENDLY).length - 1, 1);
});

test("UNCLEAR replies do NOT get a booking link pushed on them", async () => {
  const w = world({ calendly: true });
  S.ai.classification = "UNCLEAR";
  S.ai.replyBody = "Pricing depends on team size; happy to explain.";
  await reply(w, "What does this cost?");
  assert.doesNotMatch(S.mailer.sent[0].text, /calendly/i);
});

test("a client with no calendar link is never given a made-up one", async () => {
  const w = world({ calendly: false });
  S.ai.classification = "BOOKING";
  S.ai.replyBody = "Great, let's find a time.";
  await reply(w, "Yes let's talk");
  assert.doesNotMatch(S.mailer.sent[0].text, /https?:\/\//);
});

// ===================================================================== safety nets
test("machine mail (out-of-office, no-reply) is recorded but never answered", async () => {
  const w = world();
  await reply(w, "I am out of the office until Monday.", { headers: JSON.stringify([["Auto-Submitted", "auto-replied"]]) });
  assert.equal(S.mailer.sent.length, 0);
});

test("the same inbound message delivered twice is answered once", async () => {
  const w = world({ calendly: true });
  S.ai.classification = "HAPPY";
  await reply(w, "Tell me more", { messageId: "<same@gmail.test>" });
  const second = await reply(w, "Tell me more", { messageId: "<same@gmail.test>" });
  assert.equal(second.json.deduped, true);
  assert.equal(S.mailer.sent.length, 1);
});

test("after 3 automatic replies a human takes over (no 4th auto-reply)", async () => {
  const w = world({ calendly: true });
  S.ai.classification = "HAPPY";
  for (let i = 0; i < 4; i++) await reply(w, `question ${i}`);
  assert.equal(S.mailer.sent.length, 3);
});
