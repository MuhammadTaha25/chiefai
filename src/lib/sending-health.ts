import type { SupabaseClient } from "@supabase/supabase-js";
import { FORM_LEAD_SOURCE, autoSendSince } from "@/lib/campaign";
import { startOfLocalDay } from "@/lib/company-facts";
import { isValidTimeZone, localClock } from "@/lib/social-schedule";
import { resolveDailySendCap } from "@/lib/send-cap";
import { effectiveDailyLimit } from "@/lib/warmup-schedule";
import { buildSendingHealth, type DomainHealthRow, type SendingHealth } from "@/lib/sending-health-core";

/**
 * Reads one client's own data (callers pass the RLS-scoped session client, every query is also filtered by
 * client_id) and returns the dashboard "Sending health" message. Read-only. Returns null if reading fails, so the
 * card is hidden rather than showing a wrong "all good".
 */
export async function getSendingHealth(supabase: SupabaseClient, clientId: string): Promise<SendingHealth | null> {
  try {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const [clientRes, campaignRes, mailboxRes, domainRes] = await Promise.all([
      supabase.from("clients").select("timezone, outreach_send_start, outreach_send_end, daily_send_cap").eq("id", clientId).maybeSingle(),
      supabase.from("campaigns").select("id, status, send_window_start, send_window_end, timezone").eq("client_id", clientId).eq("campaign_month", month).maybeSingle(),
      supabase.from("mailboxes").select("id, address, daily_send_limit, created_at").eq("client_id", clientId).order("created_at", { ascending: true }),
      supabase.from("domains").select("domain, dns_status, dns_health").eq("client_id", clientId),
    ]);
    if (clientRes.error || campaignRes.error || mailboxRes.error || domainRes.error) return null;
    const client = clientRes.data as { timezone: string | null; outreach_send_start: string | null; outreach_send_end: string | null; daily_send_cap: number | null } | null;
    if (!client) return null;
    const campaign = campaignRes.data as { id: string; status: string; send_window_start: string | null; send_window_end: string | null; timezone: string | null } | null;
    const mailboxes = (mailboxRes.data ?? []) as { id: string; address: string; daily_send_limit: number | null; created_at: string }[];

    const tz = campaign?.timezone ?? client.timezone;
    const timezoneValid = isValidTimeZone(tz);
    const capacity = mailboxes.reduce((s, m) => s + effectiveDailyLimit(m, now.getTime(), true), 0);
    const dailyCap = resolveDailySendCap(client.daily_send_cap, capacity);

    let sentToday = 0;
    const byMailbox: Record<string, number> = {};
    let eligible = 0;
    if (timezoneValid) {
      const since = startOfLocalDay(tz as string).toISOString();
      const { data: sent } = await supabase
        .from("outreach_log")
        .select("mailbox_id")
        .eq("client_id", clientId)
        .eq("touch_number", 1)
        .gte("sent_at", since);
      for (const r of (sent ?? []) as { mailbox_id: string | null }[]) {
        sentToday++;
        if (r.mailbox_id) byMailbox[r.mailbox_id] = (byMailbox[r.mailbox_id] ?? 0) + 1;
      }
    }
    if (campaign) {
      let q = supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("campaign_id", campaign.id)
        .eq("lead_source", FORM_LEAD_SOURCE)
        .eq("status", "new")
        .eq("unsubscribed", false)
        .eq("email_bounced", false)
        .eq("booked", false);
      const autoSince = autoSendSince();
      if (autoSince) q = q.gte("created_at", autoSince);
      const { count } = await q;
      eligible = count ?? 0;
    }

    return buildSendingHealth({
      campaignActive: campaign?.status === "active",
      timezoneValid,
      windowStart: campaign?.send_window_start ?? client.outreach_send_start,
      windowEnd: campaign?.send_window_end ?? client.outreach_send_end,
      nowMinute: timezoneValid ? localClock(tz as string, now).minutes : 0,
      mailboxes: mailboxes.map((m) => ({ id: m.id, address: m.address })),
      dailyCap,
      sentToday,
      sentTodayByMailbox: byMailbox,
      eligibleLeads: eligible,
      domains: (domainRes.data ?? []) as DomainHealthRow[],
    });
  } catch (e) {
    console.error(`[sending-health] client=${clientId} failed: ${(e as Error).message}`);
    return null;
  }
}
