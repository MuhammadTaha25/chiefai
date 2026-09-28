import type { SupabaseClient } from "@supabase/supabase-js";

export function currentCampaignMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * This month's campaign for one client, created (active) if missing. Backed by
 * UNIQUE(client_id, campaign_month), so concurrent callers converge on one row
 * (23505 -> re-read). A pending/failed campaign is reactivated because leads are
 * about to be attached to it. Returns null only if the campaign cannot be read or written.
 */
export async function getOrCreateActiveCampaign(
  admin: SupabaseClient,
  clientId: string,
  targetLeads: number
): Promise<{ id: string; status: string } | null> {
  const month = currentCampaignMonth();
  const read = () =>
    admin.from("campaigns").select("id, status").eq("client_id", clientId).eq("campaign_month", month).maybeSingle<{ id: string; status: string }>();

  let { data: campaign } = await read();
  if (!campaign) {
    const { data: created, error } = await admin
      .from("campaigns")
      .insert({ client_id: clientId, campaign_month: month, target_leads: targetLeads, status: "active", started_at: new Date().toISOString() })
      .select("id, status")
      .single<{ id: string; status: string }>();
    if (error && error.code !== "23505") return null;
    campaign = created ?? (await read()).data;
  }
  if (!campaign) return null;

  if (campaign.status === "pending" || campaign.status === "failed") {
    await admin
      .from("campaigns")
      .update({ status: "active", last_error: null, started_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("client_id", clientId);
    campaign.status = "active";
  }
  return campaign;
}

/**
 * The only leads the automatic sender may email are ones created by the lead-gen FORM
 * (/api/leads/generate), i.e. leads the client asked for with specific criteria. Leads saved by default
 * elsewhere (the monthly saved-ICP campaign, imports, older generations) are never auto-sent.
 */
export const FORM_LEAD_SOURCE = "ai_prospecting";

/**
 * Optional cutoff (env AUTO_SEND_LEADS_SINCE, ISO date): only leads created at or after it are auto-sent, so
 * turning automation on never reaches back to leads that already existed. A value that does not parse fails
 * CLOSED (nothing is sent) rather than silently sending everything.
 */
export function autoSendSince(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.AUTO_SEND_LEADS_SINCE?.trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : "9999-12-31T00:00:00.000Z";
}
