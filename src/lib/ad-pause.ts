import { createAdminClient } from "@/lib/supabase/admin";
import { setCampaignStatusResilient } from "@/lib/zernio";

const ZERNIO_BASE_URL = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";

/**
 * Zernio is on a free plan, which requires splitting platforms across two
 * API keys: one for Google + Meta (covers Facebook/Instagram via placement),
 * one for TikTok + Instagram-as-a-standalone-platform if Zernio ever adds it.
 */
function zernioKeyForPlatform(platform: string): string | undefined {
  switch (platform) {
    case "google_ads":
    case "meta_ads":
      return process.env.ZERNIO_API_KEY_GOOGLE_META;
    case "tiktok_ads":
    case "instagram_ads":
      return process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM;
    default:
      return undefined;
  }
}

interface AdCampaign {
  id: string;
  client_id: string;
  platform: string;
  status: string;
  zernio_campaign_id: string | null;
  ad_id: string | null;
}

/**
 * Called when Finance zeroes a department's budget (declined budget request).
 * ad_campaigns has no department column, so this assumes "marketing" is the
 * only department that funds ads — adjust the gate below if that changes.
 *
 * Pauses every launched campaign for the client: flips internal status to
 * 'paused' unconditionally (that's the authoritative state the rest of the
 * app reads), and best-effort calls Zernio's campaign-pause endpoint per
 * docs.zernio.com/platforms/meta-ads/campaigns (PUT /ads/campaigns/{id} with
 * status: "PAUSED"). Without a Zernio API key configured yet, that call is
 * skipped — the internal pause still takes effect, recorded in error_message.
 */
export async function autoPauseAdsForDepartment(clientId: string, department: string) {
  if (department.toLowerCase() !== "marketing") {
    return { paused: [] as string[], skipped: `department "${department}" does not fund ads` };
  }

  const admin = createAdminClient();

  const { data: campaigns, error } = await admin
    .from("ad_campaigns")
    .select("id, client_id, platform, status, zernio_campaign_id, ad_id")
    .eq("client_id", clientId)
    .eq("status", "launched")
    .returns<AdCampaign[]>();

  if (error) {
    return { paused: [] as string[], error: error.message };
  }

  const paused: string[] = [];

  for (const campaign of campaigns ?? []) {
    let zernioError: string | null = null;
    const apiKey = zernioKeyForPlatform(campaign.platform);

    if (campaign.zernio_campaign_id && apiKey) {
      try {
        // The old call PUT /ads/campaigns/{id} with {status:"PAUSED"}, which is not
        // a status endpoint and never paused anything on Meta. The real one is
        // PUT /ads/campaigns/{id}/status {status:"paused", platform}.
        await setCampaignStatusResilient(campaign.platform === "instagram_ads" ? "tiktok_instagram" : "google_meta", {
          campaignId: campaign.zernio_campaign_id,
          metaAdId: campaign.ad_id,
          status: "paused",
          platform: campaign.platform === "instagram_ads" ? "instagram" : "facebook",
        });
      } catch (err) {
        zernioError = `Zernio pause call failed: ${(err as Error).message}`;
      }
    } else if (campaign.zernio_campaign_id) {
      zernioError = `No Zernio API key configured for platform "${campaign.platform}" — internal status paused, platform campaign left as-is.`;
    }

    const { error: pauseUpdateError } = await admin
      .from("ad_campaigns")
      .update({ status: "paused", error_message: zernioError })
      .eq("id", campaign.id);
    if (pauseUpdateError) {
      // Surface it instead of reporting a pause that never reached our DB
      // (e.g. ad_campaigns_status_check missing 'paused' — see fix_ad_campaigns_status_check_v3.sql).
      // eslint-disable-next-line no-console
      console.error(`auto-pause: could not record paused status for campaign ${campaign.id}: ${pauseUpdateError.message}`);
      continue;
    }

    const { error: logError } = await admin.from("agent_actions").insert({
      client_id: clientId,
      agent_name: "finance_decision_agent",
      action: "auto_pause_ad",
      payload: { campaign_id: campaign.id, platform: campaign.platform, reason: "department budget zeroed" },
      // agent_actions.result only allows 'success' | 'failed' — the pause itself
      // always succeeds (internal status), so "failed" here would mean the pause
      // didn't happen, which isn't this case even when the Zernio call is skipped.
      result: "success",
    });
    if (logError) {
      // eslint-disable-next-line no-console
      console.error(`auto_pause_ad agent_actions log failed for campaign ${campaign.id}:`, logError.message);
    }

    paused.push(campaign.id);
  }

  return { paused };
}
