import { logEvent } from "@/lib/log-event";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { findProspectsViaVibeProspecting, isVibeProspectingAuthorized } from "@/lib/vibe-prospecting-mcp";
import type { ProspectQuery } from "@/lib/explorium";
import { resolveAppOrigin } from "@/lib/app-url";
import { isLeadsMcpConnected, getRedirectUri as getLeadsRedirectUri } from "@/lib/leads-mcp";
import { frontageCallerFor } from "@/lib/frontage-caller";
import { findProspectsViaFrontageLeads, toList } from "@/lib/frontage-prospecting";

const MONTHLY_LEAD_TARGET = 12;

/** Explorium's fixed company_size buckets (fetch-entities filter enum). */
const COMPANY_SIZE_BUCKETS = [
  { max: 10, value: "1-10" },
  { max: 50, value: "11-50" },
  { max: 200, value: "51-200" },
  { max: 500, value: "201-500" },
  { max: 1000, value: "501-1000" },
  { max: 5000, value: "1001-5000" },
  { max: 10000, value: "5001-10000" },
  { max: Infinity, value: "10001+" },
] as const;

function companySizeBucketFor(minEmployees: number | null, maxEmployees: number | null): string | null {
  const anchor = maxEmployees ?? minEmployees;
  if (anchor == null) return null;
  return COMPANY_SIZE_BUCKETS.find((b) => anchor <= b.max)?.value ?? "10001+";
}

function currentCampaignMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

interface CampaignRow {
  id: string;
  client_id: string;
  campaign_month: string;
  status: string;
  target_leads: number;
  generated_leads: number;
  eligible_leads: number;
}

/**
 * Idempotent monthly campaign creation (spec §6, §44 — "duplicate monthly
 * scheduler execution must not create two campaigns"). Client identity is
 * resolved server-side from the session; a client_id in the request body
 * (there isn't one) would never be trusted anyway.
 *
 * Flow:
 * 1. Look for an existing campaign this month — if found, return it as-is
 *    and do NOTHING else. This is what actually makes re-running safe: a
 *    second scheduler run must not re-spend Vibe Prospecting credits just
 *    because it also calls this route.
 * 2. Otherwise insert a new campaign row. A concurrent duplicate insert hits
 *    the UNIQUE(client_id, campaign_month) constraint (Postgres 23505) —
 *    caught below and treated the same as "already exists", not an error.
 * 3. Only a freshly-created campaign proceeds to call Vibe Prospecting,
 *    dedupe, and select up to 12 eligible leads.
 */
export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const campaignMonth = currentCampaignMonth();
  const admin = createAdminClient();

  const { data: existing } = await supabase
    .from("campaigns")
    .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads")
    .eq("client_id", client.id)
    .eq("campaign_month", campaignMonth)
    .maybeSingle<CampaignRow>();

  // An existing campaign this month that's already pending/active/completed
  // is untouched — re-running generation for it would duplicate leads and
  // re-spend Vibe Prospecting credits for no reason (spec §6/§44
  // idempotency). A `failed` one is the one exception: nothing useful was
  // produced, so retrying reuses this same row instead of leaving the
  // client stuck with a permanently broken month.
  if (existing && existing.status !== "failed") {
    return NextResponse.json({ ok: true, campaign: existing, created: false });
  }

  let campaign: CampaignRow;
  if (existing) {
    const { data: retried, error: retryError } = await admin
      .from("campaigns")
      .update({ status: "pending", last_error: null })
      .eq("id", existing.id)
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads")
      .single<CampaignRow>();
    if (retryError || !retried) {
      return NextResponse.json({ error: retryError?.message ?? "Could not reset campaign for retry" }, { status: 500 });
    }
    campaign = retried;
  } else {
    const { data: created, error: insertError } = await admin
      .from("campaigns")
      .insert({ client_id: client.id, campaign_month: campaignMonth, target_leads: MONTHLY_LEAD_TARGET, status: "pending" })
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads")
      .single<CampaignRow>();

    if (insertError) {
      // 23505 = unique_violation — a concurrent request already created this
      // month's campaign between our SELECT and this INSERT. Not an error:
      // fetch and return that one instead of creating a second row.
      if (insertError.code === "23505") {
        const { data: raced } = await supabase
          .from("campaigns")
          .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads")
          .eq("client_id", client.id)
          .eq("campaign_month", campaignMonth)
          .maybeSingle<CampaignRow>();
        if (raced) return NextResponse.json({ ok: true, campaign: raced, created: false });
      }
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
    campaign = created;
  }

  // Load the client's saved targeting configuration — never a form the
  // client has to refill (spec §5). Only the fields the clients table
  // actually has today (icp_industry/location/min/max_employees); job
  // titles, tone, CTA, etc. from the fuller §4 form aren't captured yet.
  const { data: clientConfig } = await supabase
    .from("clients")
    .select("icp_industry, icp_location, icp_min_employees, icp_max_employees")
    .eq("id", client.id)
    .maybeSingle<{
      icp_industry: string | null;
      icp_location: string | null;
      icp_min_employees: number | null;
      icp_max_employees: number | null;
    }>();

  // The client's most recent lead-gen form answers drive targeting (countries, cities, industries) when present.
  const { data: latestJob } = await supabase
    .from("lead_gen_jobs")
    .select("criteria")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ criteria: Record<string, unknown> | null }>();
  const formCountries = toList(latestJob?.criteria?.target_countries);
  const formCities = toList(latestJob?.criteria?.target_cities);
  const formIndustries = toList(latestJob?.criteria?.target_industries);
  const frontageReady = await isLeadsMcpConnected();
  const useFrontage = frontageReady && formCountries.length > 0;

  if (!useFrontage && !clientConfig?.icp_industry) {
    await admin
      .from("campaigns")
      .update({ status: "failed", last_error: "No saved targeting configuration (icp_industry) for this client" })
      .eq("id", campaign.id);
    return NextResponse.json(
      { error: "This client has no saved prospecting configuration yet — set ICP industry/location in Business Profile first" },
      { status: 400 }
    );
  }

  const vibeReady = useFrontage || (await isVibeProspectingAuthorized());
  if (!vibeReady) {
    await admin
      .from("campaigns")
      .update({ status: "failed", last_error: "Vibe Prospecting is not connected (connect it in Settings)" })
      .eq("id", campaign.id);
    return NextResponse.json(
      { ok: true, campaign: { ...campaign, status: "failed" }, warning: "Vibe Prospecting isn't connected yet" },
      { status: 200 }
    );
  }

  await admin.from("campaigns").update({ status: "active", started_at: new Date().toISOString() }).eq("id", campaign.id);

  const query: ProspectQuery = {
    industries: clientConfig?.icp_industry ? [clientConfig.icp_industry] : [],
    companySizeRange: companySizeBucketFor(clientConfig?.icp_min_employees ?? null, clientConfig?.icp_max_employees ?? null) ?? "",
    jobTitles: [],
    keywords: clientConfig?.icp_location ? [clientConfig.icp_location] : [],
    limit: MONTHLY_LEAD_TARGET,
  };

  let prospects;
  try {
    prospects = useFrontage
      ? (
          await findProspectsViaFrontageLeads(
            {
              countries: formCountries,
              cities: formCities,
              industries: formIndustries.length ? formIndustries : query.industries,
              keywords: query.keywords,
              limit: MONTHLY_LEAD_TARGET,
            },
            frontageCallerFor(getLeadsRedirectUri(resolveAppOrigin(req, { preferEnv: false })))
          )
        ).prospects
      : await findProspectsViaVibeProspecting(query);
  } catch (err) {
    // No fake leads on failure (spec §7, §50) — record the failure and leave
    // the campaign recoverable (status stays queryable, not silently "done").
    await admin
      .from("campaigns")
      .update({ status: "failed", last_error: (err as Error).message.slice(0, 200) })
      .eq("id", campaign.id);
    logEvent("campaign.prospecting_failed", { client_id: client.id, campaign_id: campaign.id, error: (err as Error).message });
    return NextResponse.json({ error: "Prospect search failed. Please try again shortly." }, { status: 502 });
  }

  // Deduplicate against every email this client has ever contacted, not
  // just this campaign — a new month must not re-contact someone from
  // September just because it's now October (spec §8).
  const emails = prospects.map((p) => p.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e));
  const { data: alreadyContacted } = await admin
    .from("leads")
    .select("email")
    .eq("client_id", client.id)
    .in("email", emails.length > 0 ? emails : ["__none__"]);

  const contactedSet = new Set((alreadyContacted ?? []).map((r) => r.email?.toLowerCase()));
  const eligible = prospects.filter((p) => p.email && !contactedSet.has(p.email.trim().toLowerCase())).slice(0, MONTHLY_LEAD_TARGET);

  if (eligible.length > 0) {
    // One insert per lead: the unique (client_id, lower(email)) index makes a duplicate a 23505 that skips
    // just that lead instead of failing the whole batch.
    for (const p of eligible) {
      const { error: leadsError } = await admin.from("leads").insert({
        client_id: client.id,
        campaign_id: campaign.id,
        name: p.name,
        email: p.email?.trim().toLowerCase(),
        company: p.company,
        job_title: p.jobTitle,
        status: "new",
        lead_source: "vibe_prospecting",
        lead_type: "outbound",
      });
      if (leadsError && leadsError.code !== "23505") {
        await admin.from("campaigns").update({ status: "failed", last_error: leadsError.message }).eq("id", campaign.id);
        return NextResponse.json({ error: leadsError.message }, { status: 500 });
      }
    }
  }

  const { data: finalCampaign } = await admin
    .from("campaigns")
    .update({
      generated_leads: prospects.length,
      eligible_leads: eligible.length,
      status: "active",
    })
    .eq("id", campaign.id)
    .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads")
    .single<CampaignRow>();

  return NextResponse.json({ ok: true, campaign: finalCampaign, created: true });
}
