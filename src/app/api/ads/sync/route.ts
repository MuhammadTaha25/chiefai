import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronRequest } from "@/lib/webhook-security";
import {
  getAdCampaignAnalytics,
  getAdCampaignStatus,
  type CampaignAnalyticsSummary,
  type ZernioKeyGroup,
} from "@/lib/zernio";

/**
 * READ-ONLY provider reconciliation for ads. Asks Zernio/Meta what each
 * "launched"/"paused" campaign's real state is and makes OUR status agree with
 * it — it never launches, unpauses, or changes budget, so it cannot spend.
 *
 * It ALSO writes the campaign's performance into ad_performance. Without that,
 * nothing in the app ever produced an ad_performance row, and
 * decide_ad_finance (the gate that lets the SECOND and later ads spend) reads
 * `ad_performance.is_good` for the prior ad — so every ad after the first sat
 * on `pending_human` forever and could never go live. A missing/zero-impression
 * result is written as `is_good = null` (unknown), never as `false`, so an ad
 * that simply hasn't delivered yet can't be mistaken for one that performed badly.
 *
 * Auth: cron (CRON_SECRET) for every tenant, or a session for that client only.
 */

// The client's own stated goal drives what "good" means. These are deliberately
// conservative floors: an ad with no impressions yet is unknown (null), not bad.
const MIN_IMPRESSIONS_FOR_JUDGEMENT = 500;
const GOOD_CTR = 0.8; // percent — Meta feed average sits around 0.9%
const GOOD_COST_PER_RESULT = 25; // in the ad account's own currency

function judgePerformance(m: CampaignAnalyticsSummary): boolean | null {
  if ((m.impressions ?? 0) < MIN_IMPRESSIONS_FOR_JUDGEMENT) return null; // not enough data to judge
  if (m.conversions && m.conversions > 0 && m.costPerConversion && m.costPerConversion > 0) {
    return m.costPerConversion <= GOOD_COST_PER_RESULT;
  }
  if (m.ctr === null) return null;
  return m.ctr >= GOOD_CTR;
}

function zernioGroupForPlatform(platform: string): ZernioKeyGroup {
  // Must stay in sync with src/lib/ad-pause.ts and the ads create route:
  // facebook/linkedin/youtube/google_ads live under the google_meta key,
  // instagram/tiktok under the tiktok_instagram key.
  return platform === "instagram_ads" || platform === "tiktok_ads" ? "tiktok_instagram" : "google_meta";
}

async function run(req: NextRequest) {
  const admin = createAdminClient();
  let clientId: string | null = null;
  if (!isCronRequest(req.headers.get("authorization"))) {
    const { user, client } = await getCurrentClient();
    if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    clientId = client.id;
  }

  let q = admin
    .from("ad_campaigns")
    .select("id, client_id, platform, status, zernio_campaign_id")
    .in("status", ["launched", "paused", "live"])
    .not("zernio_campaign_id", "is", null);
  if (clientId) q = q.eq("client_id", clientId);
  const { data: campaigns } = await q;

  const results: {
    id: string;
    before: string;
    after: string;
    provider: string;
    performance?: CampaignAnalyticsSummary | null;
    isGood?: boolean | null;
  }[] = [];

  for (const c of campaigns ?? []) {
    if (!c.zernio_campaign_id) continue;
    // instagram_ads rows are stored under their own platform value.
    const connectionPlatform =
      c.platform === "meta_ads" ? "facebook_ads" : c.platform === "google_ads" ? "google_ads" : c.platform;
    const { data: conn } = await admin
      .from("social_connections")
      .select("zernio_account_id")
      .eq("client_id", c.client_id)
      .eq("platform", connectionPlatform)
      .eq("connection_status", "connected")
      .maybeSingle<{ zernio_account_id: string }>();
    if (!conn) {
      results.push({ id: c.id, before: c.status, after: c.status, provider: "no connected ad account (cannot verify)" });
      continue;
    }
    const group = zernioGroupForPlatform(c.platform);
    try {
      const st = await getAdCampaignStatus(group, c.zernio_campaign_id, conn.zernio_account_id);
      let next = c.status;
      let note: string;
      if (!st.found) {
        next = "error";
        note = "Provider does not confirm this campaign (missing, or no permission to read it)";
      } else {
        const s = (st.effectiveStatus ?? st.status ?? "").toUpperCase();
        note = `Provider status ${s || "unknown"}`;
        if (s.includes("PAUSED")) next = "paused";
        else if (s === "ACTIVE") next = "launched";
        // any other provider state (e.g. PENDING_REVIEW, DISAPPROVED): leave ours, but record it
      }

      // Performance sync (read-only). Only for campaigns the provider confirms,
      // so a deleted campaign can't pollute the finance ledger with a zero row.
      let perf: CampaignAnalyticsSummary | null = null;
      let isGood: boolean | null = null;
      if (st.found) {
        perf = await getAdCampaignAnalytics(group, c.zernio_campaign_id, {
          platform: c.platform === "meta_ads" ? "facebook" : c.platform === "instagram_ads" ? "instagram" : "google",
        });
        if (perf) {
          isGood = judgePerformance(perf);
          // Written through the RPC so the row is produced the same way any
          // other producer would write it (and it resolves our internal id
          // from the provider campaign id itself).
          const { error: rpcError } = await admin.rpc("sync_ad_performance", {
            p_zernio_campaign_id: c.zernio_campaign_id,
            p_impressions: perf.impressions,
            p_clicks: perf.clicks,
            p_spend: perf.spend,
            p_conversions: perf.conversions === null ? null : Math.round(perf.conversions),
            p_ctr: perf.ctr,
            p_cpa: perf.costPerConversion,
            p_is_good: isGood,
          });
          if (rpcError) note += ` | performance sync failed: ${rpcError.message.slice(0, 120)}`;
          else note += ` | perf: ${perf.impressions ?? 0} impressions, ${perf.clicks ?? 0} clicks, spend ${perf.spend ?? 0}`;
        }
      }

      await admin
        .from("ad_campaigns")
        .update({ status: next, error_message: `${note} (synced ${new Date().toISOString()})` })
        .eq("id", c.id);
      results.push({ id: c.id, before: c.status, after: next, provider: note, performance: perf, isGood });
      console.log(`[ads-sync] client=${c.client_id} campaign=${c.id} ${c.status}->${next} ${note}`);
    } catch (e) {
      // Provider unreachable: keep our status, never guess.
      results.push({ id: c.id, before: c.status, after: c.status, provider: `sync failed: ${(e as Error).message.slice(0, 80)}` });
    }
  }
  return NextResponse.json({ ok: true, results });
}

export const GET = run;
export const POST = run;
