import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deterministicAdChecks,
  generateAdCreative,
  generateAdImage,
  generateAdVideo,
  validateAdCreative,
} from "@/lib/gemini";
import { errorsOf, validateAdBrief, warningsOf } from "@/lib/ad-validation";
import { uploadAdAsset } from "@/lib/storage";
import {
  createMetaAd,
  readBackDraft,
  DEFAULT_AD_PREVIEW_FORMATS,
  estimateAudienceReach,
  getAdCampaignStatus,
  getAdPreviews,
  searchMetaGeo,
  searchMetaInterest,
  uploadAdImage,
  type ZernioKeyGroup,
} from "@/lib/zernio";
import {
  buildAdPlan,
  buildCampaignBrief,
  compareDraftToMeta,
  cleanList,
  nextCreativeVersion,
  cleanValue,
  toMetaCta,
  type AdAdjustment,
  type AdBriefInput,
  type ResolutionResult,
} from "@/lib/meta-ads";

/**
 * In-app replacement for the n8n workflow "Infomist - Ads Creative Brief ->
 * Generate -> Launch": that workflow was marked active in n8n but its
 * execution history showed zero runs despite real ad_generation_jobs sitting
 * in our database — the webhook call was never actually landing, so every
 * ad request silently stayed "pending" forever with no creative, no finance
 * decision, and no launched campaign.
 *
 * This route is the single place a Meta ad is created, and it creates the
 * WHOLE hierarchy Meta needs — campaign (objective) -> ad set (budget,
 * schedule, geo, age, gender, placements, optimization) -> ad (headline,
 * primary text, description, CTA, landing-page link, AI image) — then
 * publishes it live in the same request, with no second approval click.
 *
 * What was wrong before (fixed here):
 *   * The launch call posted to POST /v1/ads/campaigns with
 *     {platform, campaignName, dailyBudget, headlines, description, cta,
 *     landingPageUrl, targetLocation} — none of which that endpoint accepts
 *     (it takes {accountId, adAccountId, name, goal}). It created a bare
 *     campaign with NO ad set and NO ad underneath it, so nothing could ever
 *     deliver; that is the "Provider did not return a campaign id" error users
 *     were seeing.
 *   * Every answer beyond advertising_what/offer/daily_budget/ad_countries was
 *     dropped: age, gender, interests, placements, creative angle, offer,
 *     must-say, ad format, schedule. They now all feed the ad set and the
 *     creative (see src/lib/meta-ads.ts).
 *   * No image was ever produced. When the brief asks for an image creative we
 *     now generate a pain-point/situation image with Gemini, upload it to the
 *     Meta image library, and attach it to the ad.
 *
 * Google Ads is still NOT auto-launched: no proven, tested payload exists for
 * it (the one n8n workflow that targeted it was itself inactive), so creative
 * + finance still run and launch is left manual rather than guessed at.
 */

// Zernio is on a free plan split across two API-key groups (see lib/zernio.ts
// and lib/ad-pause.ts's zernioKeyForPlatform, which this must stay in sync
// with — google_ads and meta_ads share the same key group, and so does the
// instagram_ads connection).
function zernioGroupForPlatform(platform: string): ZernioKeyGroup {
  return platform === "instagram_ads" ? "tiktok_instagram" : "google_meta";
}

// A video creative is rendered by Veo (which polls for up to ~7 minutes) and
// then uploaded to Meta, which blocks until its own transcode reports ready.
// The default serverless budget would kill that mid-flight.
export const maxDuration = 300;

// Zernio returns the Meta ad account id WITHOUT the "act_" prefix from
// /accounts, but every Meta-facing create/upload call requires it WITH the
// prefix ("adAccountId must start with 'act_' for Meta platforms").
function metaAdAccountId(platform: string, accountId: string) {
  const apiKey =
    zernioGroupForPlatform(platform) === "tiktok_instagram"
      ? process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM
      : process.env.ZERNIO_API_KEY_GOOGLE_META;
  return fetch(`${process.env.ZERNIO_BASE_URL}/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const account = (data?.accounts ?? []).find(
        (a: Record<string, unknown>) => a._id === accountId
      );
      // Zernio doesn't return adAccountId at the top level — it's nested under
      // metadata.subscribedAdAccountIds (numeric, no "act_" prefix).
      // enumeratedAdAccountIds ("act_..."-prefixed) is a fallback for accounts
      // that haven't finished subscribing yet.
      const metadata = account?.metadata as
        | { subscribedAdAccountIds?: string[]; enumeratedAdAccountIds?: string[] }
        | undefined;
      const raw =
        metadata?.subscribedAdAccountIds?.[0] ??
        metadata?.enumeratedAdAccountIds?.[0]?.replace(/^act_/, "");
      return raw ? String(raw).replace(/^act_/, "") : null;
    })
    .catch(() => null);
}

// Meta refuses to deliver to an audience smaller than this, so we widen
// targeting until the estimate clears it rather than sending a request that
// comes back as a 400 after the user has already waited for the creative.
const MIN_AUDIENCE = 1000;

const ALLOWED_GOALS = [
  "Leads", "Sales", "Website visits", "WhatsApp messages",
  "Phone calls", "Bookings", "App downloads", "Brand awareness",
];

// Columns added by supabase/add_ad_launch_details.sql. They are pure metadata
// (which ad set / ad / creative was created, what targeting was sent), so if
// that migration has not been run yet we drop them and still launch the ad
// instead of failing the whole request on an unknown column.
const LAUNCH_DETAIL_COLUMNS = [
  "objective", "optimization_goal", "ad_set_id", "ad_id", "creative_id",
  "ad_set_name", "ad_name", "image_url", "targeting", "launch_payload", "reach_estimate",
] as const;

function isMissingColumnError(message: string | undefined): boolean {
  return Boolean(message && /column .* does not exist|could not find the '.*' column/i.test(message));
}

function withoutLaunchDetails(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const col of LAUNCH_DETAIL_COLUMNS) delete out[col];
  return out;
}

/**
 * Updates an ad_campaigns row, transparently retrying without the launch-detail
 * columns when the migration that adds them hasn't been applied yet.
 * Returns the final error message (null on success).
 */
async function updateCampaign(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  payload: Record<string, unknown>
): Promise<string | null> {
  const first = await admin.from("ad_campaigns").update(payload).eq("id", id);
  if (!first.error) return null;
  if (!isMissingColumnError(first.error.message)) return first.error.message;
  const retry = await admin.from("ad_campaigns").update(withoutLaunchDetails(payload)).eq("id", id);
  return retry.error?.message ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  if (platform === "google_ads") {
    return NextResponse.json(
      { error: "Publishing to Google Ads isn't supported yet. Only Facebook and Instagram ads can be created here." },
      { status: 400 }
    );
  }
  if (!["meta_ads", "instagram_ads"].includes(platform)) {
    return NextResponse.json({ error: "Unknown ad platform" }, { status: 400 });
  }

  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Validate the brief BEFORE any provider call or DB write: the finance RPC is
  // the spend gate, but it must never see a nonsense budget.
  let brief: AdBriefInput;
  try {
    brief = (await req.json()) as AdBriefInput;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  // Control flags sent alongside the form answers (not form fields themselves).
  const control = brief as AdBriefInput & { accept_adjustments?: boolean; regenerate_of?: string };
  const acceptAdjustments = control.accept_adjustments === true;
  const regenerateOf = typeof control.regenerate_of === "string" ? control.regenerate_of : null;
  delete control.accept_adjustments;
  delete control.regenerate_of;

  const dailyBudget = Number(brief?.daily_budget);
  brief.daily_budget = dailyBudget;

  // Full pre-flight validation: required fields, contradictions, unsupported
  // options, existing-audience/lookalike, URL, dates. Errors block here — before
  // any Gemini call, DB write or Meta object; warnings travel with the draft.
  const briefIssues = validateAdBrief(brief);
  const briefErrors = errorsOf(briefIssues);
  if (briefErrors.length > 0) {
    return NextResponse.json(
      { error: briefErrors.map((i) => i.message).join(" "), issues: briefIssues, code: "invalid_brief" },
      { status: 422 }
    );
  }
  const briefWarnings = warningsOf(briefIssues).map((i) => i.message);
  const advertisingWhat = cleanValue(brief.advertising_what);

  // Every form answer is turned into the Meta plan up front (objective, geo,
  // age, gender, placements, creative format, schedule) so a bad brief is
  // rejected here rather than half-created on Meta.
  const plan = buildAdPlan(brief);

  const admin = createAdminClient();
  const businessContext = await getClientBusinessContext(admin, client.id);
  const formattedContext = formatBusinessContext(businessContext);

  // Destination. Meta traffic ads must have a link, so fall back to the
  // website on the client's business profile before giving up.
  const landingPageUrl =
    cleanValue(brief.landing_page_url) || cleanValue(businessContext.website);
  if (!landingPageUrl || !/^https?:\/\//i.test(landingPageUrl)) {
    return NextResponse.json(
      {
        error:
          "This ad needs a destination URL. Add your landing page in the form (or your website in Settings -> Business profile) and resubmit.",
      },
      { status: 400 }
    );
  }

  const campaignBrief = buildCampaignBrief(brief, plan, landingPageUrl);
  const campaignBriefJson = JSON.stringify(campaignBrief);
  // Everything the system changes from what the user asked for is recorded here
  // with what / why / original / new, and shown on the review screen.
  const adjustments: AdAdjustment[] = [];
  const resolution: ResolutionResult[] = [];
  if (!cleanValue(brief.landing_page_url)) {
    adjustments.push({
      what: "Destination URL",
      original: "(empty)",
      adjusted: landingPageUrl,
      reason: "No URL was entered, so the website from your business profile was used.",
    });
  }

  // Duplicate-submission guard (a double click on a live platform would launch, and spend, twice).
  const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
  const dupSince = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const findRecentDuplicates = async () =>
    admin
      .from("ad_campaigns")
      .select("id")
      .eq("client_id", client.id)
      .eq("platform", platform)
      .eq("business_name", advertisingWhat)
      .eq("daily_budget", dailyBudget)
      .neq("status", "error")
      .neq("status", "duplicate")
      .gte("created_at", dupSince);
  if (!regenerateOf && ((await findRecentDuplicates()).data?.length ?? 0) > 0) {
    return NextResponse.json(
      { error: "An identical ad request was just submitted. Wait a couple of minutes before retrying.", code: "duplicate_submission" },
      { status: 409 }
    );
  }

  // The *_ads platform values are their own social_connections rows, kept
  // separate from the organic "facebook"/"instagram" ones (see
  // /api/zernio/connect) so connecting an ads account never overwrites (or
  // gets shadowed by) the organic social connection for the same platform.
  const connectionPlatform =
    platform === "google_ads" ? "google_ads" : platform === "meta_ads" ? "facebook_ads" : "instagram_ads";
  // What Zernio expects as "platform" in its own payloads — the organic value,
  // unrelated to which social_connections row we read the account id from.
  const zernioPlatform = platform === "google_ads" ? "google_ads" : platform === "meta_ads" ? "facebook" : "instagram";
  const group = zernioGroupForPlatform(platform);
  const platformLabel = platform === "google_ads" ? "Google Ads" : platform === "meta_ads" ? "Facebook" : "Instagram";

  const { data: connection } = await supabase
    .from("social_connections")
    .select("zernio_account_id, connection_status")
    .eq("client_id", client.id)
    .eq("platform", connectionPlatform)
    .maybeSingle();

  if (!connection || connection.connection_status !== "connected") {
    return NextResponse.json(
      { error: `Connect your ${platformLabel} account first, from the Ads page.` },
      { status: 400 }
    );
  }

  if (platform === "google_ads" && !client.google_ads_customer_id) {
    return NextResponse.json(
      { error: "Your Google Ads account is connected, but we couldn't resolve its customer ID yet. Try reconnecting." },
      { status: 400 }
    );
  }

  // ---- Meta ad account + billing -----------------------------------------
  // Meta requires a payment method on the ad account before any ad can spend —
  // check via Zernio's finance endpoint so we never launch a campaign that
  // would just fail (or worse, sit invisibly stuck) for lack of billing.
  // Instagram ads run on the same underlying Meta ad account (linked via the
  // Facebook page), so this applies to instagram_ads too, not just meta_ads.
  let adAccountId: string | null = null;
  // The ad account's own billing currency, straight from Zernio. The budget
  // the form collects is in the AD ACCOUNT's currency, not dollars — an ad
  // account billed in PKR spends 10 PKR for "10/day", so this is surfaced to
  // the user rather than silently assumed to be USD.
  let adAccountCurrency: string | null = null;
  if (platform === "meta_ads" || platform === "instagram_ads") {
    if (!connection.zernio_account_id) {
      return NextResponse.json({ error: "Your Meta connection is missing an account id. Reconnect from the Ads page." }, { status: 400 });
    }
    adAccountId = await metaAdAccountId(platform, connection.zernio_account_id);
    if (!adAccountId) {
      return NextResponse.json(
        { error: "Could not find a Meta ad account for your connected page. Reconnect from the Ads page." },
        { status: 400 }
      );
    }

    try {
      const apiKey = group === "tiktok_instagram" ? process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM : process.env.ZERNIO_API_KEY_GOOGLE_META;
      // Verified live: this endpoint rejects the bare numeric id with
      // "adAccountId must be act_<n>" — the "act_" prefix is required here
      // exactly as it is on the create call. The bare id is kept as a fallback
      // so a future provider change can't silently disable the billing check.
      const financeFor = (id: string) =>
        fetch(
          `${process.env.ZERNIO_BASE_URL}/ads/accounts/finance?accountId=${encodeURIComponent(
            connection.zernio_account_id
          )}&adAccountId=${encodeURIComponent(id)}`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );

      let financeRes = await financeFor(`act_${adAccountId}`);
      if (!financeRes.ok) financeRes = await financeFor(adAccountId);

      if (financeRes.ok) {
        const financeData = await financeRes.json();
        adAccountCurrency = typeof financeData?.currency === "string" ? financeData.currency : null;
        if (!financeData?.fundingSource) {
          return NextResponse.json(
            {
              error: "No payment method on file for this Meta ad account.",
              guidance: {
                title: "Add a bank account or card in Meta Ads Manager",
                steps: [
                  "Open Meta Ads Manager and go to Billing settings.",
                  "Click \"Add payment method\".",
                  "Choose bank account (or card) and enter your details — Meta verifies bank accounts with a small trial deposit, so this can take 1–2 days.",
                  "Come back here once it shows as active and try creating the ad again.",
                ],
                link: `https://business.facebook.com/billing_hub/payment_settings?asset_id=${encodeURIComponent(adAccountId)}`,
              },
            },
            { status: 400 }
          );
        }
      }
      // If the finance check itself fails (network/Zernio error), don't block
      // the client on our own infra issue — proceed and let Meta reject the
      // actual spend if billing really is missing.
    } catch {
      // Same non-fatal handling as above.
    }
  }

  const targetLocation = plan.countries.join(", ");

  // The Meta-only paths below all need a concrete id; the null case was already
  // rejected with a 400 above, but TypeScript cannot carry that narrowing
  // across the awaits in between, so pin it once here.
  const metaAdAccount = platform === "google_ads" ? "" : (adAccountId as string);
  // Every Meta-facing call (finance, reach estimate, image upload, create)
  // requires the "act_" prefix — confirmed live against Zernio.
  const metaAdAccountRef = metaAdAccount ? `act_${metaAdAccount}` : "";

  const { data: job, error: insertError } = await supabase
    .from("ad_generation_jobs")
    .insert({ client_id: client.id, platform, status: "pending", brief })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json(
      { error: `Could not log ad job (has the ad_generation_jobs table been created yet?): ${insertError.message}` },
      { status: 500 }
    );
  }

  // Draft ad_campaigns row first — this is what the Ads page's Finance table
  // reads, independent of ad_generation_jobs.
  const baseCampaignRow: Record<string, unknown> = {
    client_id: client.id,
    platform,
    // goal is a CHECK-constrained, user-facing label (see
    // supabase/fix_ad_campaigns_goal_check.sql) — keep the form's own words.
    goal: ALLOWED_GOALS.includes(cleanValue(brief.desired_result)) ? cleanValue(brief.desired_result) : "Leads",
    business_name: advertisingWhat,
    business_description: cleanValue(brief.offer) || advertisingWhat,
    target_location: targetLocation,
    daily_budget: dailyBudget,
    landing_page_url: landingPageUrl,
    target_audience: cleanValue(brief.audience_description),
    status: "generating",
  };

  let { data: campaign, error: campaignInsertError } = await admin
    .from("ad_campaigns")
    .insert({ ...baseCampaignRow, objective: plan.objective.goal, optimization_goal: plan.objective.optimizationGoal })
    .select("id")
    .single<{ id: string }>();

  // Same "migration not applied yet" tolerance as updateCampaign: the objective
  // columns are metadata, not a reason to refuse to launch.
  if (campaignInsertError && isMissingColumnError(campaignInsertError.message)) {
    ({ data: campaign, error: campaignInsertError } = await admin
      .from("ad_campaigns")
      .insert(baseCampaignRow)
      .select("id")
      .single<{ id: string }>());
  }

  if (campaignInsertError || !campaign) {
    await admin.from("ad_generation_jobs").update({ status: "error", last_error: campaignInsertError?.message }).eq("id", job.id);
    return NextResponse.json(
      { error: `Could not create ad campaign: ${campaignInsertError?.message}` },
      { status: 500 }
    );
  }

  if (!regenerateOf && ((await findRecentDuplicates()).data ?? []).some((r) => r.id !== campaign.id)) {
    await admin.from("ad_campaigns").update({ status: "error", error_message: "duplicate submission" }).eq("id", campaign.id);
    await admin.from("ad_generation_jobs").update({ status: "error" }).eq("id", job.id);
    return NextResponse.json({ error: "An identical ad request is already being processed.", code: "duplicate_submission" }, { status: 409 });
  }

  try {
    // ---- 1. Copy for all three levels (campaign / ad set / ad) ------------
    const creative = await generateAdCreative({
      businessContext: formattedContext,
      platform: zernioPlatform,
      advertisingWhat,
      offer: cleanValue(brief.offer) || null,
      desiredResult: cleanValue(brief.desired_result) || "Leads",
      targetLocation,
      dailyBudget,
      audienceDescription: cleanValue(brief.audience_description) || null,
      preferredCta: cleanValue(brief.ad_cta) || null,
      landingPageUrl,
      planSummary: plan.creativeAngle,
      goalRationale: plan.objective.rationale,
      campaignBriefJson,
      creativeFocus: cleanValue(brief.creative_focus) || null,
      creativeFormat: plan.creativeFormat,
      exclusions: cleanList(brief.ad_exclusions),
    });

    // ---- 1b. Review the generated ad against the brief --------------------
    // Gemini is not the final authority: a second pass checks relevance, offer
    // accuracy, unsupported claims, focus, exclusions and policy risk, and
    // deterministic checks confirm AIDA / CTA / hashtags. Problems become
    // visible warnings on the review screen, never silent.
    const expectedCta = toMetaCta(brief.ad_cta);
    const validation = await validateAdCreative({
      campaignBriefJson,
      creative,
      creativeFocus: cleanValue(brief.creative_focus) || null,
      format: plan.creativeFormat,
    });
    validation.checks.push(
      ...deterministicAdChecks(creative, expectedCta).filter((c) => c.key === "cta" || c.key === "primary_text")
    );
    const aiWarnings: string[] = [
      ...validation.checks.filter((c) => !c.pass).map((c) => `AI review — ${c.key.replace(/_/g, " ")}: ${c.note}`),
      ...validation.unsupported_claims.map((c) => `Unsupported claim flagged in the copy: "${c}"`),
      ...creative.warnings.map((w) => `AI note: ${w}`),
      ...(validation.ai_unavailable ? ["The AI review pass was unavailable — only the automatic checks ran. Read the copy carefully before publishing."] : []),
    ];
    if (expectedCta && creative.cta !== expectedCta) {
      adjustments.push({
        what: "Call-to-action button",
        original: creative.cta,
        adjusted: expectedCta,
        reason: "Your chosen button overrides the one Gemini suggested.",
      });
    }

    await updateCampaign(admin, campaign.id, {
      campaign_name: creative.campaign_name,
      ad_set_name: creative.ad_set_name,
      ad_name: creative.ad_name,
      ad_copy_headlines: creative.headlines,
      ad_copy_description: creative.description,
      ad_copy_cta: toMetaCta(brief.ad_cta) || creative.cta,
      creative_concept: creative.creative_concept,
      targeting_recommendation: creative.targeting_recommendation,
    });

    // Caption = Gemini's primary text; hashtags are appended on their own line so
    // the preview can show them separately while Meta receives one primary text.
    const hashtagLine = creative.hashtags.map((h) => `#${h}`).join(" ");
    const primaryText = [creative.body || creative.headlines[0] || advertisingWhat, hashtagLine]
      .filter(Boolean)
      .join("\n\n");

    // ---- 3. Resolve interests to Meta's own ids ---------------------------
    // Meta only accepts interest ids. Every requested interest is searched and
    // the outcome recorded (resolved / unresolved). A miss is reported to the
    // user — never silently dropped — and a match whose name differs from what
    // was asked is labelled a suggested alternative rather than passed off as
    // the same interest.
    const interestIds: { id: string; name: string }[] = [];
    const userInterests = plan.interestSeeds;
    const aiInterests = creative.interest_keywords.filter(
      (k) => !userInterests.some((u) => u.toLowerCase() === k.toLowerCase())
    );
    const looseMatch = (a: string, b: string) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x.includes(y) || y.includes(x);
    };
    const interestQueue: [string, boolean][] = [
      ...userInterests.map((seed): [string, boolean] => [seed, true]),
      ...aiInterests.map((seed): [string, boolean] => [seed, false]),
    ];
    for (const [seed, fromUser] of interestQueue.slice(0, 8)) {
      if (interestIds.length >= 5) break;
      const hit = await searchMetaInterest(group, connection.zernio_account_id, seed);
      if (!hit) {
        resolution.push({ kind: "interest", requested: seed, resolvedName: null, metaId: null, status: "unresolved" });
        if (fromUser) briefWarnings.push(`Interest "${seed}" could not be matched to a Meta interest and was left out.`);
        continue;
      }
      const alternative = !looseMatch(seed, hit.name);
      resolution.push({
        kind: "interest",
        requested: seed,
        resolvedName: hit.name,
        metaId: hit.id,
        status: "resolved",
        note: alternative
          ? "Suggested alternative — Meta's closest match, not the exact interest requested."
          : fromUser
            ? undefined
            : "AI-suggested interest.",
      });
      if (alternative && fromUser) {
        briefWarnings.push(`Interest "${seed}" isn't in Meta's library. Suggested alternative used: "${hit.name}".`);
      }
      if (!interestIds.some((i) => i.id === hit.id)) interestIds.push(hit);
    }

    // ---- 3b. Resolve the form's Cities / States to Meta geo keys ----------
    // Meta targets a city or region by OPAQUE KEY, never by name. Each name is
    // resolved against the country the brief targets and checked against the
    // states the user chose. A place that cannot be resolved is REPORTED; if
    // nothing the user asked for resolves, the draft stops rather than running
    // country-wide behind their back.
    const targetCountryCode = plan.countries[0];
    const targetingNotes: string[] = [];
    const cityTargets: { key: string; radius: number; distance_unit: "kilometer" }[] = [];
    const regionTargets: { key: string }[] = [];
    const requestedStates = cleanList(brief.ad_states);
    const requestedCities = cleanList(brief.ad_cities).slice(0, 5);
    for (const region of requestedStates.slice(0, 5)) {
      const hit = await searchMetaGeo(group, connection.zernio_account_id, region, {
        geoType: "region",
        countryCode: targetCountryCode,
      });
      if (!hit) {
        resolution.push({ kind: "region", requested: region, resolvedName: null, metaId: null, status: "unresolved" });
        briefWarnings.push(`"${region}" could not be resolved to a supported Meta region in ${targetCountryCode}. Please review.`);
        continue;
      }
      resolution.push({ kind: "region", requested: region, resolvedName: hit.name, metaId: hit.key, status: "resolved" });
      if (!regionTargets.some((r) => r.key === hit.key)) regionTargets.push({ key: hit.key });
    }
    for (const city of requestedCities) {
      const hit = await searchMetaGeo(group, connection.zernio_account_id, city, {
        geoType: "city",
        countryCode: targetCountryCode,
      });
      if (!hit) {
        resolution.push({ kind: "city", requested: city, resolvedName: null, metaId: null, status: "unresolved" });
        briefWarnings.push(`"${city}" could not be resolved to a supported Meta location. Please review.`);
        continue;
      }
      // Hierarchy check: when states were chosen and Meta gave a breadcrumb, the
      // city must sit under one of them.
      const path = (hit.path ?? []).map((p) => p.toLowerCase());
      if (
        requestedStates.length > 0 &&
        path.length > 0 &&
        !requestedStates.some((st) => path.some((p) => p.includes(st.toLowerCase())))
      ) {
        resolution.push({
          kind: "city",
          requested: city,
          resolvedName: hit.name,
          metaId: hit.key,
          status: "hierarchy_mismatch",
          note: `Found under ${(hit.path ?? []).join(" › ")}, not under ${requestedStates.join(" / ")}.`,
        });
        briefWarnings.push(
          `"${city}" resolved to ${(hit.path ?? []).join(" › ")}, which is not inside the state(s) you chose (${requestedStates.join(", ")}). It was NOT targeted — please review.`
        );
        continue;
      }
      resolution.push({ kind: "city", requested: city, resolvedName: hit.name, metaId: hit.key, status: "resolved" });
      cityTargets.push({ key: hit.key, radius: 25, distance_unit: "kilometer" });
    }
    if ((requestedCities.length > 0 || requestedStates.length > 0) && cityTargets.length === 0 && regionTargets.length === 0) {
      throw new Error(
        `None of the places you chose (${[...requestedStates, ...requestedCities].join(", ")}) could be resolved to a supported Meta location, so nothing was created — the ad would otherwise have run across all of ${plan.countries.join(", ")}. Check the spelling, or remove the city/state to target the whole country.`
      );
    }
    if (cityTargets.length || regionTargets.length) {
      targetingNotes.push(
        `Location narrowed to ${resolution
          .filter((r) => r.status === "resolved" && r.kind !== "interest")
          .map((r) => `${r.kind} ${r.resolvedName}`)
          .join(", ")} (city/region targeting replaces the country, because Meta rejects a city and its own country together).`
      );
    }

    // ---- 4. Audience sanity check + auto-widen ---------------------------
    // Meta rejects (and where it doesn't, badly under-delivers) an audience
    // under 1,000 people. Estimate first; if it is too small, widen in the least
    // destructive order — and RECORD every change (original -> new, and why) so
    // the review screen shows it. The draft is PAUSED, so the user accepts the
    // adjusted audience by publishing it or rejects it by discarding.
    const originalTargeting = {
      ageMin: plan.ageMin,
      ageMax: plan.ageMax,
      gender: plan.gender,
      interests: interestIds.map((i) => i.name),
    };
    const geoSpec: Record<string, unknown> =
      cityTargets.length || regionTargets.length
        ? {
            // NOTE: the reach-estimate endpoint spells this "distanceUnit" while
            // the create call wants "distance_unit" — the wrong one fails with
            // "radius and distanceUnit must be set together". Hence the map.
            cities: cityTargets.map((c) => ({ key: c.key, radius: c.radius, distanceUnit: c.distance_unit })),
            ...(regionTargets.length ? { regions: regionTargets } : {}),
          }
        : { countries: plan.countries };
    const baseSpec: Record<string, unknown> = {
      ...geoSpec,
      ageMin: plan.ageMin,
      ageMax: plan.ageMax,
      ...(plan.gender !== "all" ? { gender: plan.gender } : {}),
      ...(interestIds.length ? { interests: interestIds } : {}),
    };
    let reach = await estimateAudienceReach(group, {
      accountId: connection.zernio_account_id,
      adAccountId: metaAdAccountRef,
      spec: baseSpec,
      optimizationGoal: plan.objective.optimizationGoal,
    });
    if (reach && reach.upper !== null && reach.upper < MIN_AUDIENCE) {
      const tooSmall = `the estimated audience (${reach.upper.toLocaleString()} people) was below Meta's ${MIN_AUDIENCE.toLocaleString()}-person delivery minimum`;
      const widened: Record<string, unknown> = { ...geoSpec, ageMin: plan.ageMin, ageMax: plan.ageMax };
      const retry = await estimateAudienceReach(group, {
        accountId: connection.zernio_account_id,
        adAccountId: metaAdAccountRef,
        spec: widened,
        optimizationGoal: plan.objective.optimizationGoal,
      });
      if (retry && retry.upper !== null && retry.upper >= MIN_AUDIENCE) {
        adjustments.push({
          what: "Interests",
          original: originalTargeting.interests.join(", ") || "(none)",
          adjusted: "(none — broader audience)",
          reason: `Interests were removed because ${tooSmall}.`,
        });
        interestIds.length = 0;
        targetingNotes.push("Meta targeting was broadened: interests were dropped because the audience was too small.");
        reach = retry;
      } else {
        const widest: Record<string, unknown> = { ...geoSpec, ageMin: 18, ageMax: 65 };
        const retry2 = await estimateAudienceReach(group, {
          accountId: connection.zernio_account_id,
          adAccountId: metaAdAccountRef,
          spec: widest,
          optimizationGoal: plan.objective.optimizationGoal,
        });
        if (retry2 && retry2.upper !== null && retry2.upper >= MIN_AUDIENCE) {
          adjustments.push({
            what: "Interests, age and gender",
            original: `${originalTargeting.interests.join(", ") || "no interests"} · ${originalTargeting.ageMin}–${originalTargeting.ageMax} · ${originalTargeting.gender}`,
            adjusted: "no interests · 18–65 · all",
            reason: `Targeting was widened because ${tooSmall}.`,
          });
          interestIds.length = 0;
          plan.ageMin = 18;
          plan.ageMax = 65;
          plan.gender = "all";
          targetingNotes.push("Meta targeting was broadened: age and gender filters were widened to 18–65 / all because the audience was too small.");
          reach = retry2;
        } else if (retry2 && retry2.upper !== null) {
          throw new Error(
            `The audience for ${plan.countries.join(", ")} is only about ${retry2.upper.toLocaleString()} people, below Meta's 1,000-person delivery minimum. Add more countries, or a bigger country, and resubmit.`
          );
        }
      }
    }
    const widened = adjustments.filter((a) => /interests|age/i.test(a.what));
    if (widened.length > 0 && !acceptAdjustments) {
      // Nothing has been created on Meta and no media has been rendered yet.
      // Hand the proposed change back to the user; they resubmit with
      // accept_adjustments=true to proceed, or change the brief.
      const msg = "Awaiting the user's approval of automatically broadened targeting.";
      await admin.from("ad_campaigns").update({ status: "error", error_message: msg }).eq("id", campaign.id);
      await admin.from("ad_generation_jobs").update({ status: "completed", last_error: msg }).eq("id", job.id);
      return NextResponse.json(
        {
          ok: false,
          code: "needs_adjustment_approval",
          error: "Your audience is too small for Meta, so we'd need to broaden the targeting. Review the change and approve it to continue.",
          adjustments: widened,
          reach,
        },
        { status: 409 }
      );
    }
    if (widened.length > 0) {
      briefWarnings.push(
        "Your targeting was broadened automatically because the audience was too small — see \"Adjusted by the system\" below. Discard the draft if you don't accept it."
      );
    }

    // ---- 5. Creative: the user's own upload, or AI video (Veo) / AI image --
    let imageUrl: string | null = null;
    let imageHash: string | null = null;
    let videoUrl: string | null = null;
    let imageWarning: string | null = null;
    let creativeFallback: string | null = null;
    const uploadedMedia = brief.creative_media;
    const usingUploadedMedia = Boolean(uploadedMedia?.url);
    if (usingUploadedMedia && uploadedMedia?.mediaType === "video") {
      // User-supplied media is already a public URL (see /api/ads/upload-media),
      // so it is handed to Meta directly — no AI generation, no re-upload.
      videoUrl = uploadedMedia.url as string;
    } else if (usingUploadedMedia && uploadedMedia?.mediaType === "image") {
      imageUrl = uploadedMedia.url as string;
    }
    if (!usingUploadedMedia && plan.creativeFormat === "video") {
      try {
        const vid = await generateAdVideo({
          // Reuse the copywriter's pain-point scene, which already describes the
          // customer's "before" state, and re-aim it at motion.
          prompt: creative.video_prompt || creative.image_prompt || creative.pain_point || creative.creative_concept,
          aspectRatio: plan.creativeAspect === "9:16" ? "9:16" : "16:9",
        });
        const bytes = Buffer.from(vid.base64, "base64");
        videoUrl = await uploadAdAsset({
          bytes,
          contentType: vid.mimeType,
          // Object path is namespaced by client so one tenant can never
          // overwrite (or guess) another's assets, and versioned by campaign so
          // a re-launch doesn't silently reuse stale media.
          objectPath: `${client.id}/ad-${campaign.id}.mp4`,
        });
      } catch (vidErr) {
        // A video that fails to render must not lose the launch the user
        // already approved — fall back to the image creative and say so.
        imageWarning = `Video generation failed (${(vidErr as Error).message.slice(0, 200)}) — an AI image was created as a fallback instead of the video you chose. Review it before publishing.`;
        creativeFallback = "video_to_image";
      }
    }

    if (!usingUploadedMedia && (plan.creativeFormat === "image" || (plan.creativeFormat === "video" && !videoUrl))) {
      try {
        const img = await generateAdImage({
          imagePrompt: creative.image_prompt || creative.creative_concept,
          advertisingWhat,
          painPoint: creative.pain_point,
          audienceDescription: cleanValue(brief.audience_description) || null,
          creativeFocus: cleanValue(brief.creative_focus) || null,
          offer: cleanValue(brief.offer) || null,
        });
        const uploaded = await uploadAdImage(group, {
          accountId: connection.zernio_account_id,
          adAccountId: metaAdAccountRef,
          imageBase64: img.base64,
          filename: `infomist-${campaign.id}.png`,
        });
        imageUrl = uploaded.url ?? null;
        imageHash = uploaded.hash ?? null;
        if (!imageUrl && !imageHash && !imageWarning) {
          imageWarning = "The generated image could not be attached to the Meta image library, so the ad was published without it.";
        }
      } catch (imgErr) {
        // Never let our image model block a launch the user already approved:
        // record why, publish the ad, and let them add media in Ads Manager.
        const note = `Image generation failed (${(imgErr as Error).message.slice(0, 160)}) — the ad was published without an image; add one in Meta Ads Manager.`;
        imageWarning = imageWarning ? `${imageWarning} ${note}` : note;
      }
    }

    // ---- 6. Finance gate (still BEFORE any spend) ------------------------
    const { data: decision, error: decisionError } = await admin.rpc("decide_ad_finance", {
      p_client_id: client.id,
      p_ad_campaign_id: campaign.id,
    });

    if (decisionError) {
      throw new Error(`Finance decision failed: ${decisionError.message}`);
    }

    const decisionValue = String(decision).replace(/"/g, "").trim();

    if (decisionValue !== "approved") {
      const status = ["declined", "pending_human", "rejected"].includes(decisionValue) ? decisionValue : "error";
      // A "pending_human" hold is almost always the finance gate finding a
      // prior ad with no synced performance yet — a state that is invisible in
      // the ledger. Say exactly what happened and how to clear it instead of
      // reporting a bare status the user cannot act on.
      const holdReason =
        decisionValue === "pending_human"
          ? "Finance held this ad because a previous ad has no synced performance data yet. The reason is in the Finance table below; the hourly ads sync now writes performance, so this clears itself once that ad has delivered — or you can send it to Finance manually."
          : `Finance ${decisionValue} this ad, so no money was spent. The reason is in the Finance table below.`;
      await updateCampaign(admin, campaign.id, {
        status,
        error_message: holdReason,
      });
      await admin.from("ad_generation_jobs").update({ status: "completed", last_error: holdReason }).eq("id", job.id);
      return NextResponse.json({
        ok: true,
        job,
        campaignId: campaign.id,
        status: decisionValue,
        live: false,
        warning: holdReason,
      });
    }

    await updateCampaign(admin, campaign.id, { status: "approved" });

    // ---- 7. Create the live campaign + ad set + ad -----------------------
    const ad = await createMetaAd(group, {
      accountId: connection.zernio_account_id,
      adAccountId: metaAdAccountRef,
      campaignName: creative.campaign_name,
      adSetName: creative.ad_set_name,
      adName: creative.ad_name,
      goal: plan.objective.goal,
      optimizationGoal: plan.objective.optimizationGoal,
      billingEvent: plan.objective.billingEvent,
      dailyBudget,
      budgetLevel: "adset",
      // DRAFT, NOT LIVE. The whole hierarchy is created PAUSED so the user can
      // see the real creative, copy and Meta's own placement previews before a
      // single rupee moves. On Meta the pause is held on the campaign, leaving
      // the ad set and ad switched on, so ONE call to
      // PUT /ads/campaigns/{id}/status {status:"active"} brings it all live —
      // that is what POST /api/ads/campaigns/[id] {action:"publish"} does.
      status: "PAUSED",
      headline: (creative.headlines[0] ?? creative.campaign_name).slice(0, 40),
      body: primaryText,
      description: creative.description,
      callToAction: toMetaCta(brief.ad_cta) || creative.cta,
      linkUrl: landingPageUrl,
      imageUrl: imageUrl ?? undefined,
      imageHash: imageHash ?? undefined,
      // createMetaAd drops the image whenever a video is present — Meta rejects
      // a creative carrying both.
      ...(videoUrl ? { video: { url: videoUrl } } : {}),
      countries: plan.countries,
      ...(cityTargets.length ? { cities: cityTargets } : {}),
      ...(regionTargets.length ? { regions: regionTargets } : {}),
      ageMin: plan.ageMin,
      ageMax: plan.ageMax,
      gender: plan.gender,
      interests: interestIds,
      placements: plan.placements
        ? {
            publisherPlatforms: plan.placements.publisherPlatforms,
            ...(plan.placements.facebookPositions ? { facebookPositions: plan.placements.facebookPositions } : {}),
            ...(plan.placements.instagramPositions ? { instagramPositions: plan.placements.instagramPositions } : {}),
          }
        : undefined,
      startDate: plan.startDate ?? undefined,
      endDate: plan.endDate ?? undefined,
      // Required by Meta when the ad set can reach EU users (DSA art. 26).
      dsaBeneficiary: businessContext.businessName,
      dsaPayor: businessContext.businessName,
      // Stable per-campaign key: if the network drops our response and a retry
      // fires, Zernio replays the first result instead of creating (and
      // spending on) a second campaign.
      idempotencyKey: `infomist-${campaign.id}`,
    });

    const providerCampaignId = ad.platformCampaignId;
    if (!providerCampaignId) {
      // Never claim "launched" without a provider-issued campaign id.
      throw new Error("Provider did not return a campaign id — campaign not confirmed as launched");
    }
    if (!ad.platformAdSetId || !ad.platformAdId) {
      throw new Error(
        `Meta returned a campaign (${providerCampaignId}) but no ad set/ad id — the hierarchy is incomplete, so nothing would deliver.`
      );
    }

    // ---- 8. Confirm with the provider, then mark it live -----------------
    // A create response is not proof of delivery: verify the campaign really
    // exists on the provider and record what it says before calling it live.
    let verifiedNote = "Provider confirmed the campaign on create.";
    try {
      const status = await getAdCampaignStatus(group, providerCampaignId, connection.zernio_account_id);
      if (!status.found) {
        verifiedNote = "Created, but the provider does not confirm the campaign on a follow-up read yet — the ads sync cron will reconcile it.";
      } else {
        verifiedNote = `Provider status: ${(status.effectiveStatus ?? status.status ?? "unknown").toUpperCase()}.`;
      }
    } catch (verifyErr) {
      verifiedNote = `Created; verification read failed (${(verifyErr as Error).message.slice(0, 120)}). The ads sync cron will reconcile it.`;
    }

    // ---- 8b. Read the draft BACK from Meta and prove it matches -----------
    // Our create call being accepted is not proof the audience or creative Meta
    // stored are the ones the user asked for. Read the ad set and media back and
    // compare; any difference becomes a visible warning, never a silent one.
    const readBack = await readBackDraft(group, {
      accountId: connection.zernio_account_id,
      adSetId: ad.platformAdSetId,
      zernioAdId: ad.zernioAdId,
    });
    const metaChecks = compareDraftToMeta(
      {
        ageMin: plan.ageMin,
        ageMax: plan.ageMax,
        gender: plan.gender,
        countries: plan.countries,
        cityKeys: cityTargets.map((c) => c.key),
        regionKeys: regionTargets.map((r) => r.key),
        interestIds: interestIds.map((i) => i.id),
        expectedMedia: videoUrl ? "video" : imageUrl || imageHash ? "image" : "none",
      },
      readBack.adSet,
      readBack.media
    );
    const metaMismatches = metaChecks
      .filter((c) => !c.ok)
      .map((c) =>
        c.actual.startsWith("could not read")
          ? `Meta check — ${c.key}: ${c.actual}, so it is unverified. Open it in Ads Manager to confirm.`
          : `Meta check — ${c.key}: you asked for ${c.expected} but Meta has ${c.actual}.`
      );
    const adsManagerUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${metaAdAccount}`;

    const allWarnings = [...briefWarnings, ...aiWarnings, ...(imageWarning ? [imageWarning] : []), ...metaMismatches];
    const notes = [
      plan.objective.rationale,
      plan.creativesNote,
      usingUploadedMedia
        ? `Creative: your uploaded ${uploadedMedia?.mediaType} (${uploadedMedia?.filename}), attached to the ad.`
        : videoUrl
          ? `Creative: ${plan.creativeAspect} AI video (Veo), attached to the ad.`
          : imageUrl || imageHash
            ? `Creative: AI-generated ${plan.creativeAspect} image, attached to the ad.`
            : "Creative: no media could be attached — add one in Meta Ads Manager.",
      ...targetingNotes,
      // Meta charges the budget in the ad account's own currency, which is NOT
      // always what the user typed it in — say so explicitly.
      adAccountCurrency
        ? `Your Meta ad account is billed in ${adAccountCurrency}, so the daily budget of ${dailyBudget} is submitted as ${dailyBudget} ${adAccountCurrency}. No currency conversion is applied.`
        : "We couldn't read your Meta ad account's currency — check it in Meta Ads Manager, because the daily budget is charged in that currency.",
      videoUrl ? "The 8-second video compresses the four AIDA beats (hook, problem, solution, action) into short shots — it is a teaser, not a full story." : "",
      verifiedNote,
    ].filter(Boolean);

    // ---- 9. Meta's own placement previews -------------------------------
    // Rendered from the LIVE ad object so what the user reviews is exactly what
    // Meta will show, not our re-drawing of it. Read-only, and optional.
    const previews = ad.zernioAdId
      ? await getAdPreviews(group, ad.zernioAdId, DEFAULT_AD_PREVIEW_FORMATS)
      : [];

    // Creative versioning: a regeneration is a NEW paused draft that shares a
    // root with the original, so V1 is never overwritten and the user picks
    // which version to publish.
    let rootId = campaign.id;
    let version = 1;
    if (regenerateOf) {
      const { data: parent } = await admin
        .from("ad_campaigns")
        .select("id, launch_payload")
        .eq("id", regenerateOf)
        .eq("client_id", client.id)
        .maybeSingle<{ id: string; launch_payload: { root_id?: string } | null }>();
      if (parent) {
        rootId = parent.launch_payload?.root_id ?? parent.id;
        const { data: family } = await admin
          .from("ad_campaigns")
          .select("id, launch_payload")
          .eq("client_id", client.id)
          .or(`id.eq.${rootId},launch_payload->>root_id.eq.${rootId}`);
        version = nextCreativeVersion(
          (family ?? []).map((r: { launch_payload: { version?: number } | null }) => r.launch_payload?.version ?? 1)
        );
      }
    }

    await updateCampaign(admin, campaign.id, {
      // "paused" already exists in the live ad_campaigns_status_check, so the
      // draft state needs no migration.
      status: "paused",
      zernio_campaign_id: providerCampaignId,
      ad_set_id: ad.platformAdSetId,
      ad_id: ad.platformAdId,
      creative_id: ad.creativeId ?? null,
      image_url: imageUrl ?? videoUrl,
      targeting: {
        countries: plan.countries,
        cities: cityTargets,
        regions: regionTargets,
        ageMin: plan.ageMin,
        ageMax: plan.ageMax,
        gender: plan.gender,
        interests: interestIds,
        placements: plan.placements,
        optimizationGoal: plan.objective.optimizationGoal,
        billingEvent: plan.objective.billingEvent,
      },
      reach_estimate: reach,
      launch_payload: {
        notes,
        warnings: allWarnings,
        hashtags: creative.hashtags,
        aida: creative.aida,
        strategy: creative.strategy,
        ai_validation: validation,
        adjustments,
        resolution,
        creative_fallback: creativeFallback,
        campaign_brief: campaignBrief,
        original_targeting: originalTargeting,
        meta_verification: metaChecks,
        ads_manager_url: adsManagerUrl,
        // Everything needed to compare / reproduce this creative version.
        version,
        root_id: rootId,
        generated_at: new Date().toISOString(),
        prompts: { image: creative.image_prompt, video: creative.video_prompt },
        models: { text: process.env.GEMINI_MODEL ?? "gemini-3.6-flash", video: process.env.GEMINI_VIDEO_MODEL ?? "veo-3.1-fast-generate-preview" },
        // Re-checked at publish time (billing can lapse between draft and publish).
        ad_account_ref: metaAdAccountRef,
        budget: { amount: dailyBudget, type: "daily", level: "adset", currency: adAccountCurrency },
        // Kept so the preview can be re-rendered from the drafts list without
        // re-querying Meta.
        previews,
        zernio_ad_id: ad.zernioAdId ?? null,
        // Kept so an existing campaign can be reopened in the brief form,
        // pre-filled, for editing (see the "Edit" action on the Ads page).
        raw_brief: brief,
      },
      error_message: notes.join(" "),
      // NOT launched yet — this is the draft the user reviews. launched_at is
      // set by the publish action.
      launched_at: null,
    });

    await admin
      .from("ad_generation_jobs")
      .update({
        status: "completed",
        zernio_ad_id: ad.platformAdId,
        external_campaign_id: providerCampaignId,
        external_ad_group_id: ad.platformAdSetId,
        external_ad_id: ad.platformAdId,
        zernio_status: "PAUSED",
        audit_status: allWarnings.length ? "draft_with_warnings" : "draft_ready",
        recommended_action: null,
      })
      .eq("id", job.id);

    return NextResponse.json({
      ok: true,
      job,
      campaignId: campaign.id,
      // The draft exists on Meta but is PAUSED — nothing spends until the user
      // reviews the preview and publishes it.
      status: "paused",
      live: false,
      requiresPublish: true,
      campaign: {
        id: providerCampaignId,
        adSetId: ad.platformAdSetId,
        adId: ad.platformAdId,
        creativeId: ad.creativeId ?? null,
      },
      // Everything the preview screen renders.
      creative: {
        mediaUrl: videoUrl ?? imageUrl,
        mediaType: videoUrl ? "video" : imageUrl || imageHash ? "image" : "none",
        aspect: plan.creativeAspect,
        headline: (creative.headlines[0] ?? creative.campaign_name).slice(0, 40),
        body: creative.body || creative.headlines[0] || advertisingWhat,
        hashtags: creative.hashtags,
        description: creative.description,
        cta: toMetaCta(brief.ad_cta) || creative.cta,
        linkUrl: landingPageUrl,
        campaignName: creative.campaign_name,
        adSetName: creative.ad_set_name,
      },
      previews,
      version,
      metaChecks,
      adsManagerUrl,
      warnings: allWarnings,
      adjustments,
      resolution,
      aida: creative.aida,
      strategy: creative.strategy,
      validation,
      creativeFallback,
      requestedFormat: campaignBrief.creative.format,
      targeting: {
        location: cityTargets.length || regionTargets.length ? `${cityTargets.length} city / ${regionTargets.length} region target(s)` : plan.countries.join(", "),
        countries: plan.countries,
        cities: cityTargets,
        ageMin: plan.ageMin,
        ageMax: plan.ageMax,
        gender: plan.gender,
        interests: interestIds,
      },
      budget: { amount: dailyBudget, currency: adAccountCurrency, level: "daily" },
      objective: plan.objective.goal,
      optimizationGoal: plan.objective.optimizationGoal,
      reach,
      notes,
    });
  } catch (err) {
    await admin
      .from("ad_campaigns")
      .update({ status: "error", error_message: (err as Error).message })
      .eq("id", campaign.id);
    await admin
      .from("ad_generation_jobs")
      .update({ status: "error", last_error: (err as Error).message })
      .eq("id", job.id);
    return NextResponse.json({ ok: false, job, campaignId: campaign.id, error: (err as Error).message }, { status: 502 });
  }
}
