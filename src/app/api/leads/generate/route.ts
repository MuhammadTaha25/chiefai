import { logEvent } from "@/lib/log-event";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeLeadCriteria } from "@/lib/gemini";
import { findProspects, isExploriumConfigured, type ProspectResult } from "@/lib/explorium";
import { resolveAppOrigin } from "@/lib/app-url";
import { isLeadsMcpConnected, getRedirectUri as getLeadsRedirectUri } from "@/lib/leads-mcp";
import { frontageCallerFor } from "@/lib/frontage-caller";
import { findProspectsViaFrontageLeads, toList } from "@/lib/frontage-prospecting";
import { findProspectsViaVibeProspecting, isVibeProspectingAuthorized } from "@/lib/vibe-prospecting-mcp";
import { after } from "next/server";
import { sendBatchForClient } from "@/lib/send-batch";
import { convertFormToLeadsConnectorInput, type LeadsConnectorSearch } from "@/lib/gemini";
import { getOrCreateActiveCampaign, FORM_LEAD_SOURCE } from "@/lib/campaign";
import { dedupeProspects, existingLeadEmails, normEmail } from "@/lib/prospect-dedupe";

const MAX_LEADS_PER_REQUEST = 25;

// The background send that follows a generation spaces emails out with sleeps.
export const maxDuration = 300;

/**
 * In-app replacement for the old n8n lead-gen-intake webhook. Runs entirely
 * server-side here: Gemini turns the intake form's free-text answers into a
 * structured ICP query, then Explorium (once configured) sources matching
 * companies/contacts, which get inserted as `leads` rows ready for the
 * per-lead "Draft & send" AIDA flow on the Leads page. This route never sends email.
 */
export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let criteria: Record<string, string>;
  try {
    criteria = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const admin = createAdminClient();

  const { data: job, error: insertError } = await supabase
    .from("lead_gen_jobs")
    .insert({ client_id: client.id, status: "pending", criteria })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json(
      { error: `Could not log lead-gen job (has the lead_gen_jobs table been created yet?): ${insertError.message}` },
      { status: 500 }
    );
  }

  const sellingDescription = (criteria.what_you_sell as string | undefined)?.trim();
  if (!sellingDescription) {
    await admin.from("lead_gen_jobs").update({ status: "error", last_error: "what_you_sell was empty" }).eq("id", job.id);
    return NextResponse.json({ error: "Fill out \"What do you sell?\" before submitting" }, { status: 400 });
  }

  let analysis;
  try {
    analysis = await analyzeLeadCriteria({ sellingDescription, answers: criteria });
  } catch (err) {
    await admin
      .from("lead_gen_jobs")
      .update({ status: "error", last_error: `Gemini analysis failed: ${(err as Error).message}`.slice(0, 200) })
      .eq("id", job.id);
    // Provider error text can carry provider internals: log it (redacted) server-side, give the browser a generic message.
    logEvent("leadgen.failed", { client_id: client.id, job_id: job.id, stage: "analysis", error: (err as Error).message });
    return NextResponse.json({ error: "Could not analyse your criteria right now. Please try again." }, { status: 502 });
  }

  await admin
    .from("lead_gen_jobs")
    .update({ status: "analyzed", criteria: { ...criteria, ai_analysis: analysis } })
    .eq("id", job.id);

  // Each lead costs provider credits, so the
  // per-request count is capped server-side regardless of what the form sends.
  const leadCount = Math.min(Math.max(Math.floor(Number(criteria.lead_output_count as unknown)) || 5, 1), MAX_LEADS_PER_REQUEST);
  // Frontage Leads is the primary source: it honours the form's country / city / industry filters.
  const frontageReady = await isLeadsMcpConnected();
  const vibeReady = !frontageReady && (await isVibeProspectingAuthorized());

  if (!frontageReady && !vibeReady && !isExploriumConfigured()) {
    await admin
      .from("lead_gen_jobs")
      .update({
        status: "blocked_missing_prospecting_key",
        last_error:
          "No prospecting source configured — run scripts/authorize-vibe-prospecting.ts, or set EXPLORIUM_API_KEY",
      })
      .eq("id", job.id);
    return NextResponse.json({
      ok: true,
      job,
      analysis,
      warning: "Criteria analyzed, but no prospecting source is connected yet.",
    });
  }

  // Explorium/Vibe Prospecting's company_size filter is a strict enum — a
  // free-text value like "10-50 employees" (what Gemini produced before the
  // prompt above was tightened) gets rejected by the MCP tool with an
  // "invalid_enum_value" error, not silently ignored. Normalize defensively
  // here too, since an LLM following a format instruction isn't guaranteed.
  const VALID_COMPANY_SIZE_BUCKETS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
  function normalizeCompanySizeRange(raw: string): string {
    if (VALID_COMPANY_SIZE_BUCKETS.includes(raw)) return raw;
    const numbers = raw.match(/\d+/g)?.map(Number) ?? [];
    const anchor = numbers[numbers.length - 1] ?? numbers[0];
    if (anchor == null) return "1-10";
    if (anchor <= 10) return "1-10";
    if (anchor <= 50) return "11-50";
    if (anchor <= 200) return "51-200";
    if (anchor <= 500) return "201-500";
    if (anchor <= 1000) return "501-1000";
    if (anchor <= 5000) return "1001-5000";
    if (anchor <= 10000) return "5001-10000";
    return "10001+";
  }
  const companySizeRange = normalizeCompanySizeRange(analysis.companySizeRange);

  try {
    // Vibe Prospecting first (the shared, once-authorized MCP connection) —
    // falls back to Explorium's direct API only if that hasn't been set up.
    const targetIndustries = toList(criteria.target_industries);

    // Gemini converts the form answers into the connector's own input format (ISO country, city, category
    // slugs). Every value is validated against the connector before use; if Gemini fails or nothing
    // validates, the search is built directly from the form's answers instead.
    let proposals: LeadsConnectorSearch[] | undefined;
    if (frontageReady) {
      try {
        proposals = (await convertFormToLeadsConnectorInput({ sellingDescription, answers: criteria })).searches;
      } catch (err) {
        logEvent("leadgen.failed", { client_id: client.id, job_id: job.id, stage: "gemini_to_connector", error: (err as Error).message });
      }
    }

    let prospects: ProspectResult[];
    // Resubmitting the exact same Find Leads form used to always re-fetch the same top results from the
    // source (offset always started at 0), which then all got deduped away against leads already saved
    // from the LAST run — the search looked like it "did nothing" on a repeat. A cursor persisted per
    // (client, exact search criteria) lets a repeat search continue past everything already scanned.
    let frontageSearchKey: string | null = null;
    if (frontageReady) {
      const frontageQuery = {
        countries: toList(criteria.target_countries),
        cities: toList(criteria.target_cities),
        industries: targetIndustries.length ? targetIndustries : analysis.industries,
        keywords: analysis.keywords,
        limit: leadCount,
        // Previously only a soft instruction inside the Gemini prompt (never guaranteed) — now enforced
        // server-side: a country in this list is never even searched, and a result whose own city field
        // contains an excluded city name is dropped regardless of which filter matched it.
        excludedLocations: toList(criteria.excluded_locations),
      };
      frontageSearchKey = JSON.stringify({
        countries: [...frontageQuery.countries].sort(),
        cities: [...frontageQuery.cities].sort(),
        industries: [...frontageQuery.industries].sort(),
        excludedLocations: [...frontageQuery.excludedLocations].sort(),
      });
      const { data: cursorRow } = await admin
        .from("prospect_search_cursors")
        .select("next_offset")
        .eq("client_id", client.id)
        .eq("search_key", frontageSearchKey)
        .maybeSingle<{ next_offset: number }>();

      const result = await findProspectsViaFrontageLeads(
        frontageQuery,
        frontageCallerFor(getLeadsRedirectUri(resolveAppOrigin(req, { preferEnv: false }))),
        proposals,
        cursorRow?.next_offset ?? 0
      );
      prospects = result.prospects;
      const newOffset = result.exhausted ? 0 : (cursorRow?.next_offset ?? 0) + result.rowsScanned;
      await admin
        .from("prospect_search_cursors")
        .upsert(
          { client_id: client.id, search_key: frontageSearchKey, next_offset: newOffset, updated_at: new Date().toISOString() },
          { onConflict: "client_id,search_key" }
        );
    } else if (vibeReady) {
      prospects = await findProspectsViaVibeProspecting({
        industries: analysis.industries,
        companySizeRange,
        jobTitles: analysis.jobTitles,
        keywords: analysis.keywords,
        limit: leadCount,
      });
    } else {
      prospects = await findProspects({
        industries: analysis.industries,
        companySizeRange,
        jobTitles: analysis.jobTitles,
        keywords: analysis.keywords,
        limit: leadCount,
      });
    }

    // Never re-insert (and so never re-email) someone this client already has:
    // dedupe against existing leads (any case) and within this batch.
    const existing = await existingLeadEmails(admin, client.id, prospects.map((p) => normEmail(p.email)));
    const freshProspects = dedupeProspects(prospects, existing);

    // One insert per lead: the DB also enforces unique (client_id, lower(email)),
    // so a race (or a case-variant that slipped past the lookup) skips just that
    // lead (23505) instead of failing the whole batch.
    // Attach leads to this month's campaign so the scheduled sender (send-daily-batch) picks them up.
    const campaign = await getOrCreateActiveCampaign(admin, client.id, MAX_LEADS_PER_REQUEST);
    if (!campaign) throw new Error("Could not open this month's campaign");

    const insertedLeads: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let leadsError: { message: string } | null = null;
    for (const p of freshProspects) {
      const { data: row, error: insErr } = await admin
        .from("leads")
        .insert({
          client_id: client.id,
          campaign_id: campaign.id,
          name: p.name,
          email: p.email ? normEmail(p.email) : p.email,
          company: p.company,
          job_title: p.jobTitle,
          status: "new",
          lead_source: FORM_LEAD_SOURCE,
          lead_type: "outbound",
        })
        .select()
        .single();
      if (insErr) {
        if (insErr.code === "23505") continue;
        leadsError = insErr;
        break;
      }
      insertedLeads.push(row);
    }

    if (leadsError) throw new Error(leadsError.message);

    // This route itself never sends. Leads are stored as "new" on the active monthly campaign, and the
    // scheduled /api/campaigns/send-daily-batch cron sends them (daily cap, verified mailbox only). The manual
    // per-lead flow (/api/leads/[id]/send-email) still works for hand-picked sends.
    const emailsSent = 0;

    await admin
      .from("lead_gen_jobs")
      .update({ status: "completed", leads_found: insertedLeads.length })
      .eq("id", job.id);

    // Start sending right away, after the response, instead of waiting for the hourly cron. The batch applies
    // the daily cap, verified-mailbox check and per-lead claim, so it is safe alongside the cron.
    const sendingStarted = insertedLeads.length > 0;
    if (sendingStarted) {
      after(async () => {
        try {
          await sendBatchForClient(client.id);
        } catch (err) {
          logEvent("campaign.send_failed", { client_id: client.id, campaign_id: campaign.id, error: (err as Error).message });
        }
      });
    }

    return NextResponse.json({ ok: true, job, analysis, leadsFound: insertedLeads.length, emailsSent, sendingStarted });
  } catch (err) {
    await admin
      .from("lead_gen_jobs")
      .update({ status: "error", last_error: (err as Error).message.slice(0, 200) })
      .eq("id", job.id);
    logEvent("leadgen.failed", { client_id: client.id, job_id: job.id, stage: "prospecting", error: (err as Error).message });
    if (/Unrecognised target country|at least one target country/.test((err as Error).message)) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
    return NextResponse.json({ error: "Prospect search failed. Please try again shortly." }, { status: 502 });
  }
}
