import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Outreach pipeline numbers for the dashboard, computed from the app's own tables
 * (leads, outreach_log, mailboxes). This replaces a read from an n8n webhook, so the
 * dashboard no longer depends on n8n being reachable.
 *
 * Every query is filtered by client_id, and callers pass the (RLS-scoped) session
 * client, so a tenant can only ever see its own rows.
 *
 * Honesty notes: Mailgun "delivered" events are not stored by the app, so there is no
 * delivered metric - bounces (leads.email_bounced) are real, stored data and are shown instead.
 */
export interface OutreachLeadRow {
  name: string;
  email: string;
  company: string;
  touch_count: number;
  status: string;
  last_event: string;
  last_event_at: string | null;
  next_touch_at: string | null;
  reply_intent: string | null;
  reply_sentiment: string | null;
  requires_human: boolean;
}

export interface OutreachStatus {
  counts: {
    leads_found: number;
    emails_sent: number;
    bounced: number;
    replies: number;
    interested: number;
    unsubscribed: number;
    meetings_booked: number;
    mailboxes: number;
  };
  leads: OutreachLeadRow[];
  generated_at: string;
}

const INTENT: Record<string, string> = { BOOKING: "booking", HAPPY: "positive", ANGRY: "negative", UNCLEAR: "neutral" };

interface LeadDbRow {
  name: string | null;
  email: string | null;
  company: string | null;
  follow_up_number: number | null;
  next_follow_up_at: string | null;
  last_contact_at: string | null;
  reply_received: boolean | null;
  reply_classification: string | null;
  booked: boolean | null;
  unsubscribed: boolean | null;
  email_bounced: boolean | null;
  complained: boolean | null;
  manually_stopped: boolean | null;
}

function pipelineStatus(l: LeadDbRow): string {
  if (l.unsubscribed) return "unsubscribed";
  if (l.complained) return "complained";
  if (l.email_bounced) return "bounced";
  if (l.booked) return "booked";
  if (l.reply_received) return "replied";
  if (l.manually_stopped) return "stopped";
  return "in_sequence";
}

/** Returns null only when the queries themselves fail (so the UI can say so honestly). */
export async function getOutreachStatus(supabase: SupabaseClient, clientId: string): Promise<OutreachStatus | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = async (table: string, f: (q: any) => any = (q) => q): Promise<number> => {
    const { count: c, error } = await f(supabase.from(table).select("id", { count: "exact", head: true }).eq("client_id", clientId));
    if (error) throw new Error(error.message);
    return c ?? 0;
  };
  try {
    const [leadsFound, emailsSent, bounced, replies, interested, unsubscribed, booked, mailboxes] = await Promise.all([
      count("leads"),
      count("outreach_log", (q) => q.gt("touch_number", 0)),
      count("leads", (q) => q.eq("email_bounced", true)),
      count("leads", (q) => q.eq("reply_received", true)),
      count("leads", (q) => q.in("reply_classification", ["HAPPY", "BOOKING"])),
      count("leads", (q) => q.eq("unsubscribed", true)),
      count("leads", (q) => q.eq("booked", true)),
      count("mailboxes"),
    ]);

    const { data: rows, error } = await supabase
      .from("leads")
      .select("name, email, company, follow_up_number, next_follow_up_at, last_contact_at, reply_received, reply_classification, booked, unsubscribed, email_bounced, complained, manually_stopped")
      .eq("client_id", clientId)
      .not("email", "is", null)
      .order("last_contact_at", { ascending: false, nullsFirst: false })
      .limit(50)
      .returns<LeadDbRow[]>();
    if (error) throw new Error(error.message);

    return {
      counts: { leads_found: leadsFound, emails_sent: emailsSent, bounced, replies, interested, unsubscribed, meetings_booked: booked, mailboxes },
      leads: (rows ?? []).map((l) => ({
        name: l.name ?? "",
        email: l.email ?? "",
        company: l.company ?? "",
        touch_count: l.follow_up_number ?? 0,
        status: pipelineStatus(l),
        last_event: l.booked ? "booked" : l.reply_received ? "reply" : l.last_contact_at ? "email_sent" : "queued",
        last_event_at: l.last_contact_at,
        next_touch_at: l.next_follow_up_at,
        reply_intent: l.reply_classification ? INTENT[l.reply_classification] ?? "neutral" : null,
        reply_sentiment: null,
        requires_human: l.reply_classification === "ANGRY" || l.complained === true,
      })),
      generated_at: new Date().toISOString(),
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[outreach-status] client=${clientId} failed: ${(e as Error).message}`);
    return null;
  }
}
