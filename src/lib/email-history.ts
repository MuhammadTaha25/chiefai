import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recent-window transcript (oldest first) of what we sent this lead from this
 * mailbox plus their earlier replies — a sensible window (last 3 each, each
 * truncated), not the whole database history.
 */
export async function buildEmailHistory(
  admin: SupabaseClient,
  clientId: string,
  leadId: string,
  mailboxId: string
): Promise<string> {
  const [{ data: sent }, { data: received }] = await Promise.all([
    admin
      .from("outreach_log")
      .select("body, sent_at")
      .eq("client_id", clientId)
      .eq("lead_id", leadId)
      .eq("mailbox_id", mailboxId)
      .order("sent_at", { ascending: false })
      .limit(3),
    admin
      .from("inbound_messages")
      .select("body, received_at")
      .eq("client_id", clientId)
      .eq("lead_id", leadId)
      .order("received_at", { ascending: false })
      .limit(3),
  ]);
  const items = [
    ...(sent ?? []).map((m) => ({ at: m.sent_at as string, who: "We wrote", body: m.body as string | null })),
    ...(received ?? []).map((m) => ({ at: m.received_at as string, who: "They replied", body: m.body as string | null })),
  ]
    .filter((m) => m.body)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return items.map((m) => `${m.who}:\n${(m.body as string).slice(0, 600)}`).join("\n\n");
}

