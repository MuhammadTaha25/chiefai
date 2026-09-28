import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deleteAdCampaign,
  getAdAccountFinance,
  ensureZernioAdRecord,
  getAdCampaignStatus,
  setCampaignStatusResilient,
  type ZernioKeyGroup,
} from "@/lib/zernio";

/**
 * The one-click decision on a reviewed ad draft.
 *
 * POST /api/ads/[platform] no longer publishes: it builds the whole Meta
 * hierarchy PAUSED and returns Meta's own placement previews, so the user sees
 * the real creative, copy and targeting before any money moves. This route is
 * the second half of that — it either brings the reviewed draft live or throws
 * it away.
 *
 *   { action: "publish" }  -> PUT /ads/campaigns/{id}/status {status:"active"}
 *   { action: "discard" }  -> DELETE /ads/campaigns/{id}
 *
 * Publishing is deliberately a SEPARATE, explicitly-requested call rather than
 * an automatic follow-on, because it is the moment spend starts.
 */

function groupForPlatform(platform: string): ZernioKeyGroup {
  return platform === "instagram_ads" ? "tiktok_instagram" : "google_meta";
}

/** Zernio/Meta's own platform slug for the status call — not our *_ads value. */
function zernioPlatformFor(platform: string): string {
  if (platform === "meta_ads") return "facebook";
  if (platform === "instagram_ads") return "instagram";
  return "google";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (action !== "publish" && action !== "discard") {
    return NextResponse.json({ error: 'action must be "publish" or "discard"' }, { status: 400 });
  }

  // Scoped to the session's own client, so one tenant can never publish or
  // delete another tenant's campaign by guessing an id.
  const { data: campaign } = await supabase
    .from("ad_campaigns")
    .select("id, client_id, platform, status, zernio_campaign_id, ad_id, launch_payload")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle<{
      id: string;
      client_id: string;
      platform: string;
      status: string;
      zernio_campaign_id: string | null;
      ad_id: string | null;
      launch_payload: Record<string, unknown> | null;
    }>();

  if (!campaign) {
    return NextResponse.json({ error: "Ad campaign not found for this client" }, { status: 404 });
  }

  const admin = createAdminClient();
  const group = groupForPlatform(campaign.platform);

  const { data: connection } = await supabase
    .from("social_connections")
    .select("zernio_account_id")
    .eq("client_id", client.id)
    .eq(
      "platform",
      campaign.platform === "meta_ads" ? "facebook_ads" : campaign.platform === "google_ads" ? "google_ads" : campaign.platform
    )
    .eq("connection_status", "connected")
    .maybeSingle<{ zernio_account_id: string }>();

  if (!connection?.zernio_account_id) {
    return NextResponse.json({ error: "No connected ad account to act on." }, { status: 400 });
  }

  if (!campaign.zernio_campaign_id) {
    return NextResponse.json(
      { error: "This ad has no provider campaign id, so there is nothing to publish or discard." },
      { status: 400 }
    );
  }

  // ---- publish -------------------------------------------------------------
  if (action === "publish") {
    if (["launched", "live"].includes(campaign.status)) {
      return NextResponse.json({ ok: true, status: "launched", alreadyLive: true });
    }
    if (campaign.status !== "paused") {
      return NextResponse.json(
        { error: `Only a reviewed draft can be published (this one is "${campaign.status}").` },
        { status: 409 }
      );
    }

    // Final validation: the draft was built minutes or days ago, so re-read it
    // from Meta before turning it on. If it was deleted, rejected or flagged
    // in the meantime, say so instead of pressing "active" on a dead object.
    try {
      const pre = await getAdCampaignStatus(group, campaign.zernio_campaign_id, connection.zernio_account_id);
      if (!pre.found) {
        return NextResponse.json(
          { error: "This draft no longer exists on Meta (it may have been deleted in Ads Manager or the ad account lost access). Nothing was published — create a new draft." },
          { status: 409 }
        );
      }
      const preStatus = (pre.effectiveStatus ?? pre.status ?? "").toUpperCase();
      if (/DISAPPROVED|WITH_ISSUES|DELETED|ARCHIVED/.test(preStatus)) {
        return NextResponse.json(
          { error: `Meta reports this campaign as ${preStatus.replace(/_/g, " ")}, so it can't be published. Open it in Meta Ads Manager to see the reason.` },
          { status: 409 }
        );
      }
    } catch {
      // A transient read failure must not block a user who has already reviewed the draft;
      // Meta's own response to the activation below is the final authority.
    }

    // Billing can lapse between draft and publish. Only a definite "no payment
    // method" blocks; an unreadable answer (ok === null) is left to Meta.
    const adAccountRef = (campaign.launch_payload as { ad_account_ref?: string } | null)?.ad_account_ref;
    if (adAccountRef) {
      const fin = await getAdAccountFinance(group, connection.zernio_account_id, adAccountRef);
      if (fin.ok === false) {
        return NextResponse.json(
          { error: "This Meta ad account no longer has a payment method on file, so the ad can't be published. Add one in Meta Ads Manager billing settings, then publish again — the draft is kept." },
          { status: 409 }
        );
      }
    }

    try {
      await setCampaignStatusResilient(group, {
        campaignId: campaign.zernio_campaign_id,
        metaAdId: campaign.ad_id,
        status: "active",
        platform: zernioPlatformFor(campaign.platform),
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Meta did not accept the publish request: ${(err as Error).message.slice(0, 300)}. The campaign is still a paused draft and nothing was spent.` },
        { status: 502 }
      );
    }

    // A status write is not proof of delivery — read the campaign back and only
    // report it live when the provider agrees.
    let note = "Published by the user after previewing the draft.";
    let metaStatus = "";
    try {
      const status = await getAdCampaignStatus(group, campaign.zernio_campaign_id, connection.zernio_account_id);
      if (status.found) {
        const s = (status.effectiveStatus ?? status.status ?? "").toUpperCase();
        metaStatus = s;
        note = `Published by the user after previewing the draft. Provider status ${s || "unknown"}.`;
        if (s.includes("PAUSED")) {
          return NextResponse.json(
            { error: "Meta still reports this campaign as paused — it may need a moment, or the account may need attention." },
            { status: 502 }
          );
        }
      } else {
        note = "Published by the user, but the provider does not confirm the campaign yet — the ads sync will reconcile it.";
      }
    } catch {
      note = "Published by the user; the verification read failed, so the ads sync will reconcile the real state.";
    }

    // Meta reviews every new ad: it is "in review" before it is active. Record
    // that in launch_payload so the dashboard shows PENDING REVIEW, not RUNNING.
    const pendingReview = /PENDING|IN_PROCESS|REVIEW/.test(metaStatus);
    const { error: updateError } = await admin
      .from("ad_campaigns")
      .update({
        status: "launched",
        launched_at: new Date().toISOString(),
        error_message: note,
        launch_payload: { ...(campaign.launch_payload ?? {}), meta_status: metaStatus || null, pending_review: pendingReview },
      })
      .eq("id", campaign.id);

    if (updateError) {
      return NextResponse.json(
        { ok: true, status: "launched", metaStatus, pendingReview, warning: `Sent to Meta, but recording it locally failed: ${updateError.message}` },
        { status: 200 }
      );
    }

    return NextResponse.json({ ok: true, status: "launched", live: !pendingReview, pendingReview, metaStatus, note });
  }

  // ---- discard -------------------------------------------------------------
  try {
    // Repair Zernio's ad record first (see ensureZernioAdRecord): after a Facebook
    // reconnect the delete would otherwise 404 while the draft still sits on Meta.
    await ensureZernioAdRecord(group, campaign.ad_id);
    await deleteAdCampaign(group, campaign.zernio_campaign_id, connection.zernio_account_id);
  } catch (err) {
    return NextResponse.json({ error: `Could not discard: ${(err as Error).message}` }, { status: 502 });
  }

  // A campaign that was already published may have spent money before it was
  // deleted, so it must not be recorded as "nothing was ever spent".
  const wasPublished = ["launched", "live"].includes(campaign.status);

  // "declined" is the closest value the live ad_campaigns_status_check accepts
  // for "the user chose not to run this" — there is no "discarded".
  await admin
    .from("ad_campaigns")
    .update({
      status: "declined",
      error_message: wasPublished
        ? "Deleted by the user AFTER publishing. Any spend up to the moment of deletion is still billed by Meta — check Ads Manager billing."
        : "Discarded by the user before publishing. The campaign was deleted on Meta, so nothing was ever spent.",
    })
    .eq("id", campaign.id);

  await admin
    .from("ad_generation_jobs")
    .update({ status: "completed", last_error: wasPublished ? "Deleted by the user after publishing." : "Discarded by the user before publishing." })
    .eq("campaign_id", campaign.id);

  return NextResponse.json({ ok: true, status: "declined", discarded: true });
}
