/**
 * Server-only. Translates the Ads brief form (src/lib/form-schema/ads-schema.ts)
 * into the exact field set Meta requires across the three levels of an ad:
 *
 *   campaign  -> objective (goal)
 *   ad set    -> budget, schedule, geo, age, gender, placements, optimization
 *   ad/creative -> headline, primary text, description, CTA, link, image
 *
 * Why this file exists: the previous launch call only sent
 * {platform, campaignName, dailyBudget, headlines, description, cta,
 * accountId, adAccountId} to POST /v1/ads/campaigns — that endpoint wants
 * {accountId, adAccountId, name, goal} and knows nothing about budgets,
 * headlines or a landing page. The result was a bare campaign with no ad set
 * and no ad underneath it, so nothing could ever deliver, and every answer the
 * user typed into the form (age, gender, countries, interests, creative angle,
 * offer, ad format) was silently dropped on the floor.
 *
 * Everything here is deterministic and pure so it can be unit-reasoned about:
 * the AI only ever writes COPY (see generateAdCreative in lib/gemini.ts); the
 * targeting numbers and enum values that Meta validates are mapped here.
 */

// The Ads brief form submits a free-form Record<string, unknown>; AdBriefInput
// below is the typed contract for the fields this module actually reads, so a
// renamed or missing answer shows up as a type error here rather than as a
// silently dropped targeting field at launch time.

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

const AI_DECIDE = "__ai_decide__";
const NOT_SURE = "__not_sure__";

/** A form value is only usable if it is real text the user (or AI) actually chose. */
export function cleanValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s || s === AI_DECIDE || s === NOT_SURE) return "";
  return s;
}

export function cleanList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(cleanValue).filter(Boolean);
  const single = cleanValue(v);
  return single ? [single] : [];
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

/**
 * Meta only accepts ISO 3166-1 alpha-2 codes, but the form's country picker
 * (and the free-text "Other" escape hatch that allowCustom adds) hands us
 * country NAMES. Unmapped names are dropped rather than guessed at, so we can
 * never invent a country the user did not ask for.
 */
const COUNTRY_ISO2: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", us: "US", america: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", britain: "GB",
  ireland: "IE", canada: "CA", australia: "AU", "new zealand": "NZ",
  "united arab emirates": "AE", uae: "AE", dubai: "AE", "abu dhabi": "AE",
  "saudi arabia": "SA", ksa: "SA", qatar: "QA", kuwait: "KW", bahrain: "BH", oman: "OM",
  pakistan: "PK", india: "IN", bangladesh: "BD", "sri lanka": "LK", nepal: "NP",
  germany: "DE", france: "FR", netherlands: "NL", holland: "NL", belgium: "BE",
  spain: "ES", portugal: "PT", italy: "IT", switzerland: "CH", austria: "AT",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", poland: "PL",
  "czech republic": "CZ", romania: "RO", greece: "GR", turkey: "TR", "türkiye": "TR",
  "south africa": "ZA", nigeria: "NG", kenya: "KE", egypt: "EG", morocco: "MA",
  ghana: "GH", tanzania: "TZ", ethiopia: "ET",
  singapore: "SG", malaysia: "MY", indonesia: "ID", philippines: "PH", thailand: "TH",
  vietnam: "VN", japan: "JP", "south korea": "KR", korea: "KR", china: "CN",
  "hong kong": "HK", taiwan: "TW",
  brazil: "BR", mexico: "MX", argentina: "AR", chile: "CL", colombia: "CO", peru: "PE",
  russia: "RU", ukraine: "UA", israel: "IL", "hong kong sar": "HK",
};

export function toIso2Countries(values: unknown): string[] {
  const out: string[] = [];
  for (const raw of cleanList(values)) {
    const key = raw.toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();
    const mapped = COUNTRY_ISO2[key] ?? (/^[a-z]{2}$/.test(key) ? key.toUpperCase() : undefined);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demographics
// ---------------------------------------------------------------------------

/** "35–44" and "35-44" both mean age 35 to 44. "All ages" is Meta's 18–65. */
export function toAgeRange(values: unknown): { min: number; max: number } {
  const raw = cleanValue(values).replace(/–|—/g, "-");
  const match = raw.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (!match) return { min: 18, max: 65 };
  const min = Math.max(13, Math.min(65, Number(match[1])));
  const max = Math.max(min, Math.min(65, Number(match[2])));
  return { min, max };
}

export function toGender(values: unknown): "all" | "male" | "female" {
  const v = cleanValue(values).toLowerCase();
  if (v.startsWith("men") || v === "male" || v === "man") return "male";
  if (v.startsWith("women") || v === "female" || v === "woman") return "female";
  return "all";
}

// ---------------------------------------------------------------------------
// Objective / optimization
// ---------------------------------------------------------------------------

export type MetaGoal =
  | "awareness" | "traffic" | "engagement" | "video_views" | "lead_generation"
  | "lead_conversion" | "conversions" | "app_promotion" | "catalog_sales" | "page_likes";

export interface ObjectivePlan {
  /** Zernio/Meta campaign objective (goal). */
  goal: MetaGoal;
  /** Ad-set optimization_goal. Meta validates it against the objective. */
  optimizationGoal: string;
  /** Ad-set billing_event. */
  billingEvent: string;
  /** Human note explaining the mapping, surfaced in the job log. */
  rationale: string;
}

/**
 * The form asks for a desired RESULT ("Leads", "Sales", ...) in the user's own
 * words; Meta wants one of its own objectives. The mapping deliberately avoids
 * objectives that need assets we do not have (a pixel id for OFFSITE_CONVERSIONS,
 * an app-store id for app_promotion, an Instant Form for lead_generation):
 * sending those without the supporting asset is exactly what makes Meta return
 * a 400 and the ad never spend. Every ad points at the user's landing page, so
 * `traffic` (link clicks) is the objective that actually delivers — and the
 * landing page's own form is what captures the lead.
 */
export function planObjective(goalText: unknown, postAdAction: unknown): ObjectivePlan {
  const goal = cleanValue(goalText).toLowerCase();
  const action = cleanValue(postAdAction).toLowerCase();
  const both = `${goal} ${action}`;

  if (goal.includes("awareness") || goal.includes("brand")) {
    return {
      goal: "awareness",
      optimizationGoal: "REACH",
      billingEvent: "IMPRESSIONS",
      rationale: "Brand awareness objective — optimised for reach, billed per impression.",
    };
  }
  if (goal.includes("video") || action.includes("watch")) {
    return {
      goal: "video_views",
      optimizationGoal: "THRUPLAY",
      billingEvent: "IMPRESSIONS",
      rationale: "Video views objective — optimised for ThruPlay.",
    };
  }
  if (both.includes("engagement") || both.includes("like") || both.includes("comment")) {
    return {
      goal: "engagement",
      optimizationGoal: "POST_ENGAGEMENT",
      billingEvent: "IMPRESSIONS",
      rationale: "Engagement objective — optimised for post engagement.",
    };
  }
  return {
    goal: "traffic",
    optimizationGoal: "LANDING_PAGE_VIEWS",
    billingEvent: "IMPRESSIONS",
    rationale:
      "Traffic objective optimised for landing-page views, so every click is measured against the destination page and Meta promotes the placements that actually load it.",
  };
}

// ---------------------------------------------------------------------------
// Call to action
// ---------------------------------------------------------------------------

/** Meta's exact call_to_action_type enum. Anything unmapped becomes LEARN_MORE. */
const CTA_MAP: Record<string, string> = {
  "learn more": "LEARN_MORE", learnmore: "LEARN_MORE", "find out more": "LEARN_MORE",
  "book now": "BOOK_NOW", book: "BOOK_NOW", "book a call": "BOOK_NOW", booking: "BOOK_NOW",
  "schedule": "BOOK_NOW", "schedule a call": "BOOK_NOW",
  "get quote": "GET_QUOTE", quote: "GET_QUOTE", "free quote": "GET_QUOTE", "request quote": "GET_QUOTE",
  "buy now": "BUY_NOW", buy: "BUY_NOW", purchase: "BUY_NOW", checkout: "BUY_NOW",
  "shop now": "SHOP_NOW", shop: "SHOP_NOW",
  "sign up": "SIGN_UP", signup: "SIGN_UP", register: "REGISTER", "free trial": "SIGN_UP",
  "contact us": "CONTACT_US", contact: "CONTACT_US", enquire: "CONTACT_US", "get in touch": "CONTACT_US",
  whatsapp: "CONTACT_US", "whatsapp message": "CONTACT_US", "send whatsapp message": "CONTACT_US",
  download: "DOWNLOAD", "download app": "DOWNLOAD",
  "subscribe": "SUBSCRIBE", "apply now": "APPLY_NOW", apply: "APPLY_NOW",
  "request demo": "REQUEST_DEMO", demo: "REQUEST_DEMO", "book a demo": "REQUEST_DEMO",
  "call": "CONTACT_US", "phone": "CONTACT_US", "visit website": "LEARN_MORE",
  "fill a form": "SIGN_UP", "fill form": "SIGN_UP", "lead form": "SIGN_UP",
  "see more": "LEARN_MORE", "learn": "LEARN_MORE",
};

export function toMetaCta(values: unknown): string | null {
  const key = cleanValue(values).toLowerCase();
  if (!key) return null;
  return CTA_MAP[key] ?? null;
}

// ---------------------------------------------------------------------------
// Placements (from the form's "Where do you want to advertise?" answer)
// ---------------------------------------------------------------------------

export interface PlacementPlan {
  publisherPlatforms: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
}

/**
 * When the user ticks both Facebook and Instagram we let Meta run automatic
 * placements across both (its recommended default, and the best-performing
 * option for small budgets). When they tick only ONE of the two, we pin the
 * ad to that platform so we never spend on a surface they did not ask for.
 */
export function planPlacements(platforms: unknown): PlacementPlan | null {
  const selected = cleanList(platforms).map((p) => p.toLowerCase());
  if (selected.length === 0) return null;
  const wantsFacebook = selected.some((p) => p.includes("facebook") || p === "meta");
  const wantsInstagram = selected.some((p) => p.includes("instagram"));
  if (wantsFacebook && wantsInstagram) return null; // automatic placements across both
  if (wantsFacebook) {
    return {
      publisherPlatforms: ["facebook"],
      // "video_feeds" is NOT listed: Meta deprecated that placement and rejects the
      // whole ad set with subcode 2490562 if it is selected (seen live).
      facebookPositions: ["feed", "story", "facebook_reels", "marketplace", "search"],
    };
  }
  if (wantsInstagram) {
    return {
      publisherPlatforms: ["instagram"],
      instagramPositions: ["stream", "story", "reels", "explore", "profile_feed"],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Creative format
// ---------------------------------------------------------------------------

export type CreativeFormat = "image" | "video";

/** Aspect ratio the generated creative must be rendered at. */
export type CreativeAspect = "1:1" | "16:9" | "9:16";

/**
 * Video and Reel are now REAL video ads: an 8-second clip is rendered with
 * Veo describing the same pain-point scene the image prompt would, uploaded to
 * the public ads bucket, and handed to Meta as the ad's `video`.
 *
 * (Before this, "Video" quietly downgraded to a still image — Meta rejects a
 * video ad that carries no video file, so shipping a video creative with no
 * footage was not an option.)
 *
 * "Carousel" and "Existing post" still resolve to an image: a carousel needs
 * one asset per card, and reusing an existing post needs a post id the form
 * never collects.
 */
export function planCreativeFormat(
  adFormat: unknown,
  hasAssets: unknown
): { format: CreativeFormat; aspect: CreativeAspect; note: string } {
  const fmt = cleanValue(adFormat).toLowerCase();
  const assets = cleanValue(hasAssets).toLowerCase() === "yes";

  if (fmt.includes("reel")) {
    return {
      format: "video",
      aspect: "9:16",
      note: assets
        ? "A 9:16 vertical video was generated for this Reel. You said you already have footage — uploading your own file isn't wired up yet, so swap the media in Meta Ads Manager if you'd rather use it."
        : "8-second vertical (9:16) video generated from your brief, rendered by Veo and attached as the ad's video creative.",
    };
  }
  if (fmt.includes("video")) {
    return {
      format: "video",
      aspect: "16:9",
      note: assets
        ? "A 16:9 video was generated for this campaign. You said you already have footage — uploading your own file isn't wired up yet, so swap the media in Meta Ads Manager if you'd rather use it."
        : "8-second video generated from your brief, rendered by Veo and attached as the ad's video creative.",
    };
  }
  if (fmt.includes("carousel")) {
    return {
      format: "image",
      aspect: "1:1",
      note: "Carousel was requested; the creative ships as a single AI-generated hero image because carousel cards need one asset per card and none were supplied.",
    };
  }
  if (fmt.includes("existing post")) {
    return {
      format: "image",
      aspect: "1:1",
      note: "You chose to reuse an existing post; no post id came through the form, so a fresh AI-generated image is used instead.",
    };
  }
  return { format: "image", aspect: "1:1", note: "Image creative generated from your brief." };
}

// ---------------------------------------------------------------------------
// Whole-brief plan
// ---------------------------------------------------------------------------

export interface AdBriefInput {
  advertising_what?: string;
  offer?: string;
  why_choose_you?: unknown;
  desired_result?: string;
  post_ad_action?: string;
  audience_description?: string;
  age_range?: string;
  gender?: string;
  interests?: unknown;
  ad_countries?: unknown;
  ad_states?: unknown;
  ad_cities?: unknown;
  language?: string;
  has_existing_audience?: string;
  existing_audience_sources?: unknown;
  target_similar?: string;
  daily_budget?: unknown;
  campaign_duration?: string;
  start_date?: string;
  end_date?: string;
  platforms?: unknown;
  creative_focus?: string;
  ad_format?: string;
  has_creative_assets?: string;
  /** Set when the user uploaded their own creative instead of asking us to generate one. */
  creative_media?: { url?: string; mediaType?: "image" | "video"; filename?: string } | null;
  main_message?: string;
  ad_cta?: string;
  landing_destination?: string;
  landing_page_url?: string;
  conversion_tracking?: string;
  ad_exclusions?: unknown;
}

export interface AdPlan {
  objective: ObjectivePlan;
  countries: string[];
  ageMin: number;
  ageMax: number;
  gender: "all" | "male" | "female";
  placements: PlacementPlan | null;
  creativeFormat: CreativeFormat;
  /** Aspect ratio the generated creative must be rendered at. */
  creativeAspect: CreativeAspect;
  creativesNote: string;
  /** ISO dates (YYYY-MM-DD) or null. */
  startDate: string | null;
  endDate: string | null;
  /** Free-text interest seeds for the Meta interest search (resolved to ids later). */
  interestSeeds: string[];
  /** Extra context handed to the copywriter + image generator. */
  creativeAngle: string;
  adsLive: boolean;
  warnings: string[];
}

const DURATION_DAYS: Record<string, number> = {
  "7 days": 7, "14 days": 14, "30 days": 30, "60 days": 60, "90 days": 90,
};

function toIsoDate(value: unknown): string | null {
  const raw = cleanValue(value);
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * One place that turns every answer the Ads form collected into the plan the
 * launch call needs. Nothing here calls out to a provider, so the caller can
 * log exactly what was decided before any money can be committed.
 */
export function buildAdPlan(brief: AdBriefInput): AdPlan {
  const warnings: string[] = [];
  const objective = planObjective(brief.desired_result, brief.post_ad_action);
  const { min: ageMin, max: ageMax } = toAgeRange(brief.age_range);
  const gender = toGender(brief.gender);

  let countries = toIso2Countries(brief.ad_countries);
  if (countries.length === 0) {
    // Meta defaults to US when no geo is given, which would silently spend in
    // the wrong country for a non-US business. The form marks countries
    // required, so reaching here means an unmapped custom entry.
    warnings.push("No valid country could be resolved from your answers — defaulting to the United States. Add a country code (e.g. IE) and resubmit to change it.");
    countries = ["US"];
  }

  const selectedPlatforms = cleanList(brief.platforms);
  const otherPlatforms = selectedPlatforms.filter(
    (p) => !/facebook|instagram|meta/i.test(p)
  );
  if (otherPlatforms.length > 0) {
    warnings.push(`This ad is being created on Meta (Facebook/Instagram) only; ${otherPlatforms.join(", ")} need separate campaigns, so they were not launched from this form.`);
  }

  const { format: creativeFormat, aspect: creativeAspect, note: creativesNote } = planCreativeFormat(
    brief.ad_format,
    brief.has_creative_assets
  );

  const startDate = toIsoDate(brief.start_date) ?? new Date().toISOString().slice(0, 10);
  let endDate = toIsoDate(brief.end_date);
  if (!endDate) {
    const days = DURATION_DAYS[cleanValue(brief.campaign_duration)] ?? null;
    if (days) {
      const d = new Date(`${startDate}T00:00:00Z`);
      // Meta treats an ad set's end date as EXCLUSIVE, at UTC midnight: a
      // 2-day campaign sent as start+2 stops ~24h after it starts (and Meta
      // clamps a past start to "now", losing another day). The +1 makes an
      // N-day campaign actually run N full days.
      d.setUTCDate(d.getUTCDate() + days + 1);
      endDate = d.toISOString().slice(0, 10);
    }
  }
  if (endDate && endDate < startDate) {
    warnings.push("The end date was before the start date — the ad is running with no end date.");
    endDate = null;
  }

  const interestSeeds = cleanList(brief.interests);
  const whyYou = cleanList(brief.why_choose_you);

  const creativeAngle = [
    cleanValue(brief.creative_focus) ? `Lead with: ${cleanValue(brief.creative_focus)}.` : "",
    cleanValue(brief.main_message) ? `Must say: ${cleanValue(brief.main_message)}.` : "",
    whyYou.length ? `Differentiators to use: ${whyYou.join(", ")}.` : "",
    cleanValue(brief.offer) ? `Offer to feature: ${cleanValue(brief.offer)}.` : "",
    cleanValue(brief.audience_description) ? `Speaks to: ${cleanValue(brief.audience_description)}.` : "",
    cleanValue(brief.language) ? `Language: ${cleanValue(brief.language)}.` : "",
    cleanList(brief.ad_exclusions).length
      ? `Do NOT target or appeal to: ${cleanList(brief.ad_exclusions).join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (cleanValue(brief.has_existing_audience).toLowerCase() === "yes") {
    const sources = cleanList(brief.existing_audience_sources);
    warnings.push(
      `You said you already have an audience${sources.length ? ` (${sources.join(", ")})` : ""}. Custom/lookalike audiences have to be uploaded to Meta first, so this campaign runs on interest, demographic and location targeting instead. Upload the customer list in Meta Ads Manager, then attach the audience to this ad set.`
    );
  }

  return {
    objective,
    countries,
    ageMin,
    ageMax,
    gender,
    placements: planPlacements(brief.platforms),
    creativeFormat,
    creativeAspect,
    creativesNote,
    startDate,
    endDate,
    interestSeeds,
    creativeAngle,
    // The user's whole point: once the form is submitted the ad goes live
    // itself, with no second approval click. The finance gate still runs
    // BEFORE this call and can still block the spend.
    adsLive: true,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Structured campaign brief
// ---------------------------------------------------------------------------

/**
 * The form's answers as ONE structured object. This — not raw form text — is
 * what is stored with the job, handed to Gemini as context and used to
 * validate the generated ad, so every answer has a single, named home.
 */
export interface CampaignBrief {
  business: { what_are_you_advertising: string; offer: string; why_choose_you: string[] };
  campaign: { objective_requested: string; meta_objective: string; desired_action: string };
  audience: { description: string; age_min: number; age_max: number; gender: string; interests: string[]; language: string };
  location: { countries: string[]; states: string[]; cities: string[] };
  existing_audience: { enabled: boolean; sources: string[]; lookalike: boolean };
  budget: { daily_budget: number; currency: "ACCOUNT_CURRENCY"; duration_days: number | null; start_date: string | null; end_date: string | null };
  platforms: string[];
  creative: { focus: string; format: string; has_assets: boolean; main_message: string };
  cta: { button: string; destination: string; url: string };
  tracking: { conversion_tracking: string };
  exclusions: string[];
}

export function buildCampaignBrief(brief: AdBriefInput, plan: AdPlan, landingPageUrl: string): CampaignBrief {
  const days = DURATION_DAYS[cleanValue(brief.campaign_duration)] ?? null;
  return {
    business: {
      what_are_you_advertising: cleanValue(brief.advertising_what),
      offer: cleanValue(brief.offer),
      why_choose_you: cleanList(brief.why_choose_you),
    },
    campaign: {
      objective_requested: cleanValue(brief.desired_result),
      meta_objective: plan.objective.goal,
      desired_action: cleanValue(brief.post_ad_action),
    },
    audience: {
      description: cleanValue(brief.audience_description),
      age_min: plan.ageMin,
      age_max: plan.ageMax,
      gender: plan.gender,
      interests: cleanList(brief.interests),
      language: cleanValue(brief.language),
    },
    location: {
      countries: plan.countries,
      states: cleanList(brief.ad_states),
      cities: cleanList(brief.ad_cities),
    },
    existing_audience: {
      enabled: cleanValue(brief.has_existing_audience).toLowerCase() === "yes",
      sources: cleanList(brief.existing_audience_sources),
      lookalike: cleanValue(brief.target_similar).toLowerCase() === "yes",
    },
    budget: {
      daily_budget: Number(brief.daily_budget) || 0,
      currency: "ACCOUNT_CURRENCY",
      duration_days: days,
      start_date: plan.startDate,
      end_date: plan.endDate,
    },
    platforms: cleanList(brief.platforms),
    creative: {
      focus: cleanValue(brief.creative_focus),
      format: plan.creativeFormat === "video" ? (plan.creativeAspect === "9:16" ? "reel" : "video") : "image",
      has_assets: cleanValue(brief.has_creative_assets).toLowerCase() === "yes",
      main_message: cleanValue(brief.main_message),
    },
    cta: {
      button: toMetaCta(brief.ad_cta) ?? "",
      destination: cleanValue(brief.landing_destination),
      url: landingPageUrl,
    },
    tracking: { conversion_tracking: cleanValue(brief.conversion_tracking) },
    exclusions: cleanList(brief.ad_exclusions),
  };
}

// ---------------------------------------------------------------------------
// Adjustments — anything the system changed from what the user asked for
// ---------------------------------------------------------------------------

/** One automatic change, always reported with what / why / original / new. */
export interface AdAdjustment {
  what: string;
  original: string;
  adjusted: string;
  reason: string;
}

/** Outcome of resolving one requested city / state / interest to a Meta id. */
export interface ResolutionResult {
  kind: "city" | "region" | "interest";
  requested: string;
  resolvedName: string | null;
  metaId: string | null;
  status: "resolved" | "unresolved" | "hierarchy_mismatch";
  note?: string;
}

// ---------------------------------------------------------------------------
// Creative versions
// ---------------------------------------------------------------------------

/** Next version number for a regenerated creative, given the versions already saved for the same brief. */
export function nextCreativeVersion(existing: (number | null | undefined)[]): number {
  const nums = existing.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// ---------------------------------------------------------------------------
// Meta read-back verification
// ---------------------------------------------------------------------------

export interface MetaCheck {
  key: string;
  ok: boolean;
  expected: string;
  actual: string;
}

/**
 * Compares what we SENT to Meta with what Meta reports it STORED (raw Graph
 * ad-set targeting + the ad's media). Pure, so it is testable without Meta.
 * A null ad set / media list means "could not read it back" and yields a single
 * not-verified check rather than a false pass.
 */
export function compareDraftToMeta(
  sent: {
    ageMin: number;
    ageMax: number;
    gender: "all" | "male" | "female";
    countries: string[];
    cityKeys: string[];
    regionKeys: string[];
    interestIds: string[];
    expectedMedia: "image" | "video" | "none";
  },
  adSet: Record<string, unknown> | null,
  media: { type: string }[] | null
): MetaCheck[] {
  const checks: MetaCheck[] = [];
  const t = (adSet?.targeting ?? null) as Record<string, unknown> | null;

  if (!t) {
    checks.push({ key: "audience", ok: false, expected: "readable ad set", actual: "could not read the ad set back from Meta" });
  } else {
    const ageMin = Number(t.age_min);
    const ageMax = Number(t.age_max);
    checks.push({
      key: "age",
      ok: ageMin === sent.ageMin && ageMax === sent.ageMax,
      expected: `${sent.ageMin}–${sent.ageMax}`,
      actual: `${Number.isFinite(ageMin) ? ageMin : "?"}–${Number.isFinite(ageMax) ? ageMax : "?"}`,
    });

    const genders = Array.isArray(t.genders) ? (t.genders as number[]) : [];
    const actualGender = genders.length === 0 || genders.length > 1 ? "all" : genders[0] === 1 ? "male" : genders[0] === 2 ? "female" : "all";
    checks.push({ key: "gender", ok: actualGender === sent.gender, expected: sent.gender, actual: actualGender });

    const geo = (t.geo_locations ?? {}) as { countries?: string[]; cities?: { key?: string }[]; regions?: { key?: string }[] };
    const actualCities = (geo.cities ?? []).map((c) => String(c.key));
    const actualRegions = (geo.regions ?? []).map((r) => String(r.key));
    if (sent.cityKeys.length || sent.regionKeys.length) {
      const missingCities = sent.cityKeys.filter((k) => !actualCities.includes(k));
      const missingRegions = sent.regionKeys.filter((k) => !actualRegions.includes(k));
      checks.push({
        key: "location",
        ok: missingCities.length === 0 && missingRegions.length === 0,
        expected: `${sent.cityKeys.length} city + ${sent.regionKeys.length} region target(s)`,
        actual: `${actualCities.length} city + ${actualRegions.length} region target(s)`,
      });
    } else {
      const actualCountries = (geo.countries ?? []).map(String);
      const same = sent.countries.length === actualCountries.length && sent.countries.every((c) => actualCountries.includes(c));
      checks.push({ key: "location", ok: same, expected: sent.countries.join(", "), actual: actualCountries.join(", ") || "none" });
    }

    const flex = Array.isArray(t.flexible_spec) ? (t.flexible_spec as { interests?: { id?: string }[] }[]) : [];
    const actualInterests = flex.flatMap((f) => (f.interests ?? []).map((i) => String(i.id)));
    const missing = sent.interestIds.filter((id) => !actualInterests.includes(id));
    checks.push({
      key: "interests",
      ok: missing.length === 0,
      expected: `${sent.interestIds.length} interest(s)`,
      actual: `${actualInterests.length} interest(s)`,
    });
  }

  if (sent.expectedMedia !== "none") {
    if (media === null) {
      checks.push({ key: "creative", ok: false, expected: sent.expectedMedia, actual: "could not read the ad's media back from Meta" });
    } else {
      const has = media.some((m) => m.type === sent.expectedMedia);
      checks.push({
        key: "creative",
        ok: has,
        expected: sent.expectedMedia,
        actual: media.length ? media.map((m) => m.type).join(", ") : "no media on the ad",
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Interest matching
// ---------------------------------------------------------------------------

export interface InterestCandidate {
  id: string;
  name: string;
  path?: string[];
}

/** Meta tags entertainment/proper-noun interests with these suffixes — never a sensible business audience. */
const ENTERTAINMENT_TAG =
  /\((band|musician|singer|rapper|album|song|musical|film|movie|tv programme|tv series|television|actor|actress|artist|video game|book|novel|comic|character|record label|podcast|youtube channel|website)\)/i;

/**
 * Meta's interest search returns loosely related results in relevance order,
 * and the first one is often wrong ("Real estate" -> "Real Estate (band)").
 * This scores every candidate so the audience is built from a sensible one:
 * entertainment-tagged interests are rejected, an exact base-name match wins,
 * top-level categories beat "Additional interests", and names containing every
 * word of the request beat those that don't. Returns null if nothing usable.
 */
export function pickInterest(seed: string, candidates: InterestCandidate[]): InterestCandidate | null {
  const words = seed.toLowerCase().split(/\s+/).filter(Boolean);
  const norm = (s: string) => s.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase();
  let best: { c: InterestCandidate; score: number } | null = null;
  for (const c of candidates) {
    if (!c?.id || !c?.name) continue;
    if (ENTERTAINMENT_TAG.test(c.name)) continue;
    const base = norm(c.name);
    let score = 0;
    if (base === seed.toLowerCase()) score += 6;
    if (words.length > 0 && words.every((w) => base.includes(w))) score += 2;
    if (c.path && !c.path.some((p) => /additional interests/i.test(p))) score += 3;
    if (/\((?!.*\b(band)\b).+\)$/.test(c.name)) score += 1; // Meta's own category tag
    if (!best || score > best.score) best = { c, score };
  }
  return best ? best.c : null;
}
