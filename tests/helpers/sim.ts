/**
 * Simulation harness. The REAL sending code (send-batch, follow-ups, mailbox-readiness, warm-up, health, domain
 * checks, compliance footer, lint) runs unchanged against:
 *   - an in-memory database (fake-db.ts)
 *   - a fake mailer that records every email and can be told to fail
 *   - fake AI drafters that record what they were asked
 * No network is ever touched and no real email is ever sent.
 *
 * Needs: node --test --experimental-test-module-mocks --import ./scripts/register-alias.mjs
 */
import { mock } from "node:test";
import { FakeDb, type Row } from "./fake-db.ts";

const src = (p: string) => new URL(`../../src/${p}`, import.meta.url).href;

export const db = new FakeDb();

export interface SentMail {
  domain: string; from: string; to: string; subject: string; text: string;
  inReplyTo?: string; headers?: Record<string, string>; id: string;
}
export const mailer = {
  sent: [] as SentMail[],
  /** Mailgun domain state per address domain; anything not listed is "ready". */
  readiness: new Map<string, string>(),
  failTimes: 0,
  failMessage: "Mailgun 500 (simulated)",
  seq: 0,
  reset() { this.sent = []; this.readiness.clear(); this.failTimes = 0; this.seq = 0; },
};

export const ai = {
  followUpCalls: [] as Record<string, unknown>[],
  followUpFailTimes: 0,
  followUpSubject: "Totally different subject",
  /** When set, every call returns a different body (real drafts differ per touch; identical ones are rejected as templated). */
  rotateBodies: true,
  followUpBody: "Hey there, just floating this back up in case it got buried. Happy to share a quick example if it helps. Would a short chat next week suit you?",
  aidaCalls: [] as Record<string, unknown>[],
  aidaFails: false,
  aidaSubject: "Faster follow-ups for agents",
  aidaBody:
    "Hi Sam,\n\nMost real estate teams lose warm enquiries because replies come hours late. We set up automatic replies and follow-ups so every enquiry gets an answer within minutes, and your agents only step in once a buyer is ready to talk.\n\nWould it be useful if I sent over a short example of how it works for an agency your size?\n\nBest,\nTest Co",
  /** Inbound-reply simulation: what the classifier says, and what the reply drafter writes. */
  classification: "UNCLEAR" as "BOOKING" | "HAPPY" | "ANGRY" | "UNCLEAR",
  replyCalls: [] as Record<string, unknown>[],
  /** Simulates a Gemini outage/slowdown: classifyReply never answers. */
  classifyHangs: false,
  replyBody: "Thanks for getting back to me. Happy to help with any questions you have.",
  defaultAidaBody: "",
  defaultFollowUpBody: "",
  reset() {
    this.followUpCalls = []; this.followUpFailTimes = 0; this.aidaCalls = []; this.aidaFails = false;
    this.aidaBody = this.defaultAidaBody;
    this.followUpSubject = "Totally different subject";
    this.followUpBody = this.defaultFollowUpBody;
    this.aidaSubject = "Faster follow-ups for agents";
    this.classification = "UNCLEAR"; this.replyCalls = []; this.classifyHangs = false;
  },
};

ai.defaultAidaBody = ai.aidaBody;
ai.defaultFollowUpBody = ai.followUpBody;

export async function loadApp() {
  mock.module(src("lib/supabase/admin.ts"), { namedExports: { createAdminClient: () => db } });
  mock.module(src("lib/mailgun.ts"), {
    namedExports: {
      mailgunDomainForAddress: (address: string) => {
        const at = address.lastIndexOf("@");
        return (at === -1 ? address : address.slice(at + 1)).trim().toLowerCase();
      },
      getMailboxReadiness: async (address: string) => mailer.readiness.get(address.split("@").pop()!.toLowerCase()) ?? "ready",
      sendMail: async (p: Omit<SentMail, "id">) => {
        if (mailer.failTimes > 0) { mailer.failTimes--; throw new Error(mailer.failMessage); }
        const id = `<sim-${++mailer.seq}@mg.test>`;
        mailer.sent.push({ ...p, id });
        return { id };
      },
    },
  });
  mock.module(src("lib/gemini.ts"), {
    namedExports: {
      draftFollowUpEmail: async (params: Record<string, unknown>) => {
        ai.followUpCalls.push(params);
        if (ai.followUpFailTimes > 0) { ai.followUpFailTimes--; throw new Error("Gemini 429 (simulated)"); }
        const variants = [
          ai.followUpBody,
          "Quick thought for Acme: when enquiries land during viewings, who picks them up? Curious whether some wait until evening and go cold. Is that something you see?",
          "Different question entirely: what does your team do with enquiries that arrive on weekends? Wondering if a simple auto-reply could cover that gap. Worth exploring?",
        ];
        const body = ai.rotateBodies && ai.followUpBody === ai.defaultFollowUpBody ? variants[(ai.followUpCalls.length - 1) % variants.length] : ai.followUpBody;
        return { subject: ai.followUpSubject, body };
      },
      classifyReply: async () => (ai.classifyHangs ? new Promise<never>(() => {}) : { classification: ai.classification, confidence: 0.9, reason: "simulated" }),
      generateMeetingTopic: async () => "Automating customer follow-ups",
      draftReplyEmail: async (params: Record<string, unknown>) => { ai.replyCalls.push(params); return { subject: "Re: your reply", body: ai.replyBody }; },
      draftOfferPhrases: async () => ({ offer: "automate customer follow-ups", benefit: "save hours every week" }),
      draftAidaEmail: async (params: Record<string, unknown>) => {
        ai.aidaCalls.push(params);
        if (ai.aidaFails) throw new Error("Gemini timeout (simulated)");
        return { subject: ai.aidaSubject, body: ai.aidaBody };
      },
    },
  });
  mock.module(src("lib/calendly.ts"), { namedExports: { getFreshCalendlyToken: async () => null, createLeadMeetingLink: async () => null } });
  mock.module(src("lib/business-context.ts"), { namedExports: { getClientBusinessContext: async () => ({}), formatBusinessContext: () => "" } });
  mock.module(src("lib/email-history.ts"), { namedExports: { buildEmailHistory: async () => "" } });
  mock.module(src("lib/vibe-prospecting-mcp.ts"), { namedExports: { fetchCompanyDescriptionViaMcp: async () => null } });

  const [followUps, sendBatch, readiness, warmup] = await Promise.all([
    import("../../src/lib/follow-ups.ts"),
    import("../../src/lib/send-batch.ts"),
    import("../../src/lib/mailbox-readiness.ts"),
    import("../../src/lib/warmup-schedule.ts"),
  ]);
  return { followUps, sendBatch, readiness, warmup };
}

/** The webhook/cron routes (events, inbound reply, bounce-retry). Call after loadApp() so the same mocks apply. */
export async function loadRoutes() {
  const [events, inbound, bounceRetry] = await Promise.all([
    import("../../src/app/api/webhooks/mailgun/events/route.ts"),
    import("../../src/app/api/webhooks/mailgun/route.ts"),
    import("../../src/app/api/cron/bounce-retry/route.ts"),
  ]);
  return { events, inbound, bounceRetry };
}

// ---------------------------------------------------------------- time
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Wednesday 14 Oct 2026, 08:10 UTC: inside the first mailbox block of the default 08:00-24:00 window. */
export const T0 = Date.UTC(2026, 9, 14, 8, 10, 0);

export function startClock(at = T0) { mock.timers.enable({ apis: ["Date"], now: at }); }
export function setClock(at: number) { mock.timers.setTime(at); }
export function stopClock() { mock.timers.reset(); }
export const now = () => Date.now();

export function resetWorld() {
  db.clear(); mailer.reset(); ai.reset();
  delete process.env.AUTO_SEND_LEADS_SINCE;
}

// ---------------------------------------------------------------- seed helpers
let n = 0;
export const uid = (p: string) => `${p}-${++n}`;

export function seedClient(over: Row = {}): Row {
  const c = {
    id: uid("client"), company_name: "Test Co", timezone: "UTC", postal_address: "1 Test Street, Testville",
    outreach_send_start: null, outreach_send_end: null, daily_send_cap: null,
    outreach_template_subject: null, outreach_template_body: null, ...over,
  };
  db.rows("clients").push(c);
  return c;
}
export function seedJob(clientId: string, criteria: Row = {}) {
  db.rows("lead_gen_jobs").push({
    id: uid("job"), client_id: clientId, status: "completed", created_at: new Date(now()).toISOString(),
    criteria: { what_you_sell: "AI automation for real estate agencies", follow_ups: "3 follow-ups", follow_up_delay_days: 0.01, ...criteria },
  });
}
export function seedCampaign(clientId: string, over: Row = {}): Row {
  const m = new Date(now());
  const c = {
    id: uid("camp"), client_id: clientId, status: "active", sent_count: 0,
    campaign_month: `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}-01`,
    send_window_start: null, send_window_end: null, timezone: null, template_subject: null, template_body: null, ...over,
  };
  db.rows("campaigns").push(c);
  return c;
}
export function seedMailbox(clientId: string, over: Row = {}): Row {
  const id = uid("mbx");
  const mb = {
    id, client_id: clientId, address: `${id}@sim-${id}.test`, daily_send_limit: 30,
    created_at: new Date(now() - 90 * DAY).toISOString(), ...over,
  };
  db.rows("mailboxes").push(mb);
  return mb;
}
export function seedLead(clientId: string, over: Row = {}): Row {
  const l = {
    id: uid("lead"), client_id: clientId, campaign_id: null, name: "Sam Agent", company: "Acme Realty", job_title: "Owner",
    email: `${uid("p")}@prospect.test`, city: "Austin", country: "US", lead_source: "ai_prospecting", status: "new",
    follow_up_number: null, next_follow_up_at: null, last_contact_at: null,
    reply_received: false, unsubscribed: false, email_bounced: false, booked: false, complained: false, manually_stopped: false,
    created_at: new Date(now() - DAY).toISOString(), ...over,
  };
  db.rows("leads").push(l);
  return l;
}
/** A lead that already got its first email from `mailboxId`, with the follow-up due `dueInMs` from now. */
export function seedSentLead(clientId: string, mailboxId: string, opts: { dueInMs?: number; subject?: string; messageId?: string; lead?: Row } = {}): Row {
  const lead = seedLead(clientId, {
    status: "email_sent", follow_up_number: 1, last_contact_at: new Date(now() - HOUR).toISOString(),
    next_follow_up_at: new Date(now() + (opts.dueInMs ?? -MIN)).toISOString(), ...opts.lead,
  });
  db.rows("outreach_log").push({
    id: uid("log"), client_id: clientId, lead_id: lead.id, mailbox_id: mailboxId, touch_number: 1,
    subject: opts.subject ?? "Faster follow-ups for agents", body: "First email body. ".repeat(10),
    provider_message_id: opts.messageId ?? `<first-${lead.id}@mg.test>`, sent_at: new Date(now() - HOUR).toISOString(),
    created_at: new Date(now() - HOUR).toISOString(),
  });
  return lead;
}
export const leadRow = (id: string): Row => db.all("leads").find((l) => l.id === id)!;
export const logFor = (leadId: string) => db.all("outreach_log").filter((r) => r.lead_id === leadId);
export const realLog = () => db.all("outreach_log").filter((r) => !String(r.provider_message_id ?? "").startsWith("pending:"));
export const pendingLog = () => db.all("outreach_log").filter((r) => String(r.provider_message_id ?? "").startsWith("pending:"));
export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
