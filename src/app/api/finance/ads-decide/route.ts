import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * decide_ad_finance is a decision ORACLE only, same split as
 * src/app/api/finance/decide/route.ts: it evaluates, inserts its own
 * ad_finance_decisions row, and logs to agent_actions — it does not touch
 * ad_campaigns.status. This route does the follow-through: on approval the
 * campaign becomes eligible to actually spend on Meta, on rejection it's
 * blocked, on the ambiguous case it waits for a human.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { ad_campaign_id } = await req.json();
  if (!ad_campaign_id) {
    return NextResponse.json({ error: "ad_campaign_id is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: campaign, error: campaignError } = await admin
    .from("ad_campaigns")
    .select("id, client_id, status")
    .eq("id", ad_campaign_id)
    .eq("client_id", client.id)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: "Ad campaign not found for this client" }, { status: 404 });
  }

  // A campaign that already exists at the provider must not be re-decided here:
  // that would overwrite its real state ("launched"/"paused") with "approved".
  if (["launched", "paused"].includes((campaign as { status: string }).status)) {
    return NextResponse.json({ error: `Campaign is already ${(campaign as { status: string }).status} at the provider` }, { status: 409 });
  }

  const { data: decision, error: rpcError } = await admin.rpc("decide_ad_finance", {
    p_client_id: client.id,
    p_ad_campaign_id: ad_campaign_id,
  });

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const { data: latestDecision } = await admin
    .from("ad_finance_decisions")
    .select("*")
    .eq("ad_campaign_id", ad_campaign_id)
    .order("decided_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Must match ad_campaigns_status_check exactly (see
  // supabase/fix_ad_campaigns_status_check*.sql) — "rejected" and
  // "pending_finance" are NOT allowed values. Using either here made the
  // update below fail the check constraint silently: updateError got set,
  // but the UI's onDecided() callback just calls router.refresh() without
  // checking it, so a real failure looked identical to "nothing happened".
  const statusForDecision: Record<string, string> = {
    approved: "approved",
    declined: "declined",
    pending_human: "pending_human",
  };

  const newStatus = statusForDecision[decision] ?? "error";

  const { data: updatedCampaign, error: updateError } = await admin
    .from("ad_campaigns")
    .update({ status: newStatus })
    .eq("id", ad_campaign_id)
    .select()
    .maybeSingle();

  return NextResponse.json({
    ok: !updateError,
    decision,
    finance_decision: latestDecision,
    ad_campaign: updatedCampaign,
    ...(updateError ? { update_error: updateError.message } : {}),
  });
}
