/**
 * Pure pre-flight validation for the Ads brief. Runs BEFORE any Gemini call or
 * Meta object is created, on both the client (instant feedback) and the server
 * (the authority). Nothing here calls a provider.
 *
 * Severity:
 *   error   — blocks submission; the brief is invalid, contradictory or asks for
 *             something the backend cannot publish.
 *   warning — the ad can still be built, but the user must be told (something is
 *             unverifiable, not enforceable, or will be adjusted).
 *
 * Every value the backend cannot honour is REJECTED or DISCLOSED here rather
 * than silently dropped — see UNSUPPORTED_* below, which the form also reads to
 * disable the same options in the UI.
 */
import { cleanList, cleanValue, toAgeRange, toIso2Countries, type AdBriefInput } from "./meta-ads.ts";

export interface AdIssue {
  code: string;
  field: string;
  message: string;
  severity: "error" | "warning";
}

/** Platforms this module can actually publish to. Everything else is "coming soon". */
export const SUPPORTED_PLATFORMS = ["Facebook", "Instagram"];
export const UNSUPPORTED_PLATFORMS = ["Google", "YouTube", "LinkedIn", "TikTok"];

/** Formats the backend can really produce. Carousel needs one asset per card; Existing post needs a post id. */
export const UNSUPPORTED_FORMATS = ["Carousel", "Existing post"];

/** Destinations the launch call (a link ad) cannot honour. */
export const UNSUPPORTED_DESTINATIONS = ["WhatsApp", "Phone", "Lead form"];

/** Campaign goals that need assets the app does not have (WhatsApp number, phone destination, app-store id). */
export const UNSUPPORTED_GOALS = ["WhatsApp messages", "Phone calls", "App downloads"];

/** "After seeing the ad" actions that need one of the unsupported destinations. */
export const UNSUPPORTED_ACTIONS = ["Send WhatsApp message", "Call", "Download app"];

const URL_DESTINATIONS = ["Website", "Landing page", "Checkout", "Calendly"];

const norm = (v: unknown) => cleanValue(v).toLowerCase();
const inList = (v: unknown, list: string[]) => list.some((x) => x.toLowerCase() === norm(v));

function err(code: string, field: string, message: string): AdIssue {
  return { code, field, message, severity: "error" };
}
function warn(code: string, field: string, message: string): AdIssue {
  return { code, field, message, severity: "warning" };
}

export function validateAdBrief(brief: AdBriefInput, today: Date = new Date()): AdIssue[] {
  const issues: AdIssue[] = [];

  // ---- required basics -----------------------------------------------------
  if (!cleanValue(brief.advertising_what)) {
    issues.push(err("required", "advertising_what", "\"What are you advertising?\" is required."));
  }
  if (!cleanValue(brief.desired_result)) {
    issues.push(err("required", "desired_result", "Choose the result you want (Leads, Sales, Website visits…)."));
  }

  // ---- platform ------------------------------------------------------------
  const platforms = cleanList(brief.platforms);
  const supported = platforms.filter((p) => /facebook|instagram|meta/i.test(p));
  const unsupported = platforms.filter((p) => !/facebook|instagram|meta/i.test(p));
  if (platforms.length > 0 && supported.length === 0) {
    issues.push(
      err(
        "unsupported_platform",
        "platforms",
        `${unsupported.join(", ")} can't be published from here yet — only Facebook and Instagram are supported. Choose at least one of those.`
      )
    );
  } else if (unsupported.length > 0) {
    issues.push(
      warn(
        "unsupported_platform",
        "platforms",
        `${unsupported.join(", ")} ${unsupported.length > 1 ? "are" : "is"} not supported yet and will be ignored. This ad is created on ${supported.join(" + ")} only.`
      )
    );
  }

  // ---- location ------------------------------------------------------------
  const rawCountries = cleanList(brief.ad_countries);
  if (rawCountries.length === 0) {
    issues.push(err("required", "ad_countries", "Choose at least one country."));
  } else {
    const resolved = toIso2Countries(rawCountries);
    if (resolved.length === 0) {
      issues.push(
        err("bad_country", "ad_countries", `We couldn't recognise "${rawCountries.join(", ")}" as a country. Pick one from the list or use a country name / 2-letter code.`)
      );
    } else if (resolved.length < rawCountries.length) {
      issues.push(warn("bad_country", "ad_countries", "Some countries you typed weren't recognised and were left out. Check the review screen."));
    }
  }
  if (cleanList(brief.ad_cities).length > 0 && toIso2Countries(brief.ad_countries).length > 1) {
    issues.push(
      warn(
        "city_multi_country",
        "ad_cities",
        "Cities are looked up in the FIRST country you chose only. If a city is in another country, target that country on its own."
      )
    );
  }

  // ---- audience ------------------------------------------------------------
  const ageRaw = cleanValue(brief.age_range);
  if (ageRaw && !/all ages/i.test(ageRaw)) {
    const m = ageRaw.replace(/–|—/g, "-").match(/(\d{1,2})\s*-\s*(\d{1,2})|(\d{1,2})\s*\+/);
    if (!m) issues.push(err("bad_age", "age_range", `"${ageRaw}" isn't an age range Meta understands. Use a range like 25-44.`));
    else {
      const { min, max } = toAgeRange(ageRaw);
      if (m[1] && (Number(m[1]) < 13 || Number(m[2]) > 65 || Number(m[1]) > Number(m[2]))) {
        issues.push(err("bad_age", "age_range", "Meta only accepts ages 13–65 with the minimum below the maximum."));
      } else if (m[1] && (min !== Number(m[1]) || max !== Number(m[2]))) {
        issues.push(warn("age_adjusted", "age_range", `Age range adjusted to ${min}–${max} to fit Meta's limits.`));
      }
      if (m[3]) issues.push(warn("age_adjusted", "age_range", `"${ageRaw}" is sent to Meta as ${min}–65 (Meta's maximum age is 65).`));
    }
  }
  if (!cleanValue(brief.audience_description)) {
    issues.push(warn("no_audience", "audience_description", "No audience description: the copy and image will be written for a generic audience."));
  }

  // ---- existing audience ---------------------------------------------------
  if (norm(brief.has_existing_audience) === "yes") {
    if (cleanList(brief.existing_audience_sources).length === 0) {
      issues.push(err("audience_source", "existing_audience_sources", "You said you have an existing audience — choose which one (customer list, website visitors…)."));
    } else {
      issues.push(
        warn(
          "custom_audience_unsupported",
          "existing_audience_sources",
          "Existing-audience uploads aren't supported yet, so this ad is NOT sent to your customer list. It runs on location/age/interest targeting; upload the list in Meta Ads Manager and attach it to the ad set."
        )
      );
    }
  }
  if (norm(brief.target_similar) === "yes") {
    issues.push(
      err(
        "lookalike_unsupported",
        "target_similar",
        "Lookalike targeting needs a source audience uploaded to Meta first, and none exists here. Set \"target similar people\" to No, or create the lookalike in Meta Ads Manager."
      )
    );
  }

  // ---- goal / action / destination -----------------------------------------
  const goal = norm(brief.desired_result);
  const action = norm(brief.post_ad_action);
  const dest = cleanValue(brief.landing_destination);

  if (inList(brief.desired_result, UNSUPPORTED_GOALS)) {
    issues.push(err("unsupported_goal", "desired_result", `"${cleanValue(brief.desired_result)}" campaigns aren't supported yet — they need a WhatsApp/phone/app destination this app can't attach. Choose Leads, Sales, Website visits, Bookings or Brand awareness.`));
  }
  if (inList(brief.post_ad_action, UNSUPPORTED_ACTIONS)) {
    issues.push(err("unsupported_action", "post_ad_action", `"${cleanValue(brief.post_ad_action)}" isn't supported yet — the ad can only send people to a web link.`));
  }
  if (inList(dest, UNSUPPORTED_DESTINATIONS)) {
    issues.push(err("unsupported_destination", "landing_destination", `"${dest}" isn't supported yet — the ad can only send people to a web page. Choose Website, Landing page, Calendly or Checkout.`));
  }
  if (!dest) {
    issues.push(err("required", "landing_destination", "Choose where people should go after clicking the ad."));
  }

  const isPurchaseAction = action === "buy";
  const isLeadGoal = ["leads", "bookings", "brand awareness", "website visits"].includes(goal);
  if (isLeadGoal && isPurchaseAction) {
    issues.push(err("conflict", "post_ad_action", `Your goal is "${cleanValue(brief.desired_result)}", but the customer action is "Buy". Change the goal to Sales, or change the action.`));
  }
  if (goal === "sales" && ["fill a form", "book a call"].includes(action)) {
    issues.push(err("conflict", "post_ad_action", `Your goal is Sales, but the customer action is "${cleanValue(brief.post_ad_action)}". Change the goal to Leads/Bookings, or the action to Buy.`));
  }
  if (dest.toLowerCase() === "checkout" && isLeadGoal && goal !== "website visits") {
    issues.push(err("conflict", "landing_destination", `Your goal is "${cleanValue(brief.desired_result)}", but the destination is Checkout (a purchase page). Pick a landing page, website or Calendly link — or change the goal to Sales.`));
  }
  if (dest.toLowerCase() === "calendly" && action === "buy") {
    issues.push(err("conflict", "landing_destination", "The action is \"Buy\" but the destination is Calendly (a booking page). Change one of them."));
  }

  // ---- URL -----------------------------------------------------------------
  const url = cleanValue(brief.landing_page_url);
  if (inList(dest, URL_DESTINATIONS)) {
    if (!url) {
      issues.push(warn("url_fallback", "landing_page_url", "No URL entered — the website from your business profile will be used. Add the exact page here to change it."));
    }
  }
  if (url && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) {
    issues.push(err("bad_url", "landing_page_url", "The landing-page URL must start with http:// or https:// and be a real address."));
  }

  // ---- CTA vs destination --------------------------------------------------
  const cta = norm(brief.ad_cta);
  if (cta && ["whatsapp", "call", "phone"].includes(cta)) {
    issues.push(warn("cta_adjusted", "ad_cta", `The "${cleanValue(brief.ad_cta)}" button is sent to Meta as "Contact Us" and links to your page — it will not open ${cta === "whatsapp" ? "WhatsApp" : "a phone call"}.`));
  }
  if ((cta === "buy now" || cta === "shop now") && dest && dest.toLowerCase() !== "checkout" && dest.toLowerCase() !== "website") {
    issues.push(warn("cta_mismatch", "ad_cta", `The button says "${cleanValue(brief.ad_cta)}" but the destination is ${dest}. Make sure that page actually lets people buy.`));
  }
  if ((cta === "book now" || cta === "get quote") && dest.toLowerCase() === "checkout") {
    issues.push(warn("cta_mismatch", "ad_cta", `The button says "${cleanValue(brief.ad_cta)}" but the destination is Checkout.`));
  }

  // ---- creative format -----------------------------------------------------
  if (inList(brief.ad_format, UNSUPPORTED_FORMATS)) {
    issues.push(err("unsupported_format", "ad_format", `"${cleanValue(brief.ad_format)}" isn't supported yet (${norm(brief.ad_format) === "carousel" ? "a carousel needs one asset per card" : "reusing a post needs a post id"}). Choose Image, Video or Reel.`));
  }
  if (norm(brief.has_creative_assets) === "yes") {
    issues.push(warn("own_assets_unsupported", "has_creative_assets", "Uploading your own images/videos isn't supported yet, so AI-generated creative is used. Swap the media in Meta Ads Manager if you prefer your own."));
  }
  if (!cleanValue(brief.creative_focus)) {
    issues.push(warn("no_focus", "creative_focus", "No creative focus chosen — the ad will lead with the customer's problem."));
  }

  // ---- budget / dates ------------------------------------------------------
  const budget = Number(brief.daily_budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    issues.push(err("bad_budget", "daily_budget", "Enter a daily budget greater than 0."));
  } else if (budget > 10000) {
    issues.push(err("bad_budget", "daily_budget", "Daily budget above 10,000 isn't allowed from this form."));
  } else if (budget < 1) {
    issues.push(err("bad_budget", "daily_budget", "The daily budget is below Meta's minimum. Enter at least 1 in your ad account's currency (Meta may require more for some objectives)."));
  }

  const todayIso = today.toISOString().slice(0, 10);
  const startRaw = cleanValue(brief.start_date);
  const endRaw = cleanValue(brief.end_date);
  const start = startRaw ? new Date(startRaw) : null;
  const end = endRaw ? new Date(endRaw) : null;
  if (startRaw && Number.isNaN(start?.getTime())) issues.push(err("bad_date", "start_date", "The start date isn't a valid date."));
  if (endRaw && Number.isNaN(end?.getTime())) issues.push(err("bad_date", "end_date", "The end date isn't a valid date."));
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
    issues.push(err("bad_date", "end_date", "The end date is before the start date."));
  }
  if (start && !Number.isNaN(start.getTime()) && start.toISOString().slice(0, 10) < todayIso) {
    issues.push(warn("date_adjusted", "start_date", "The start date is in the past — Meta starts it as soon as it's published."));
  }
  // Meta rejects a daily-budget ad set that runs for less than 24 hours (subcode
  // 1487793, seen live). The end date is exclusive at UTC midnight and the ad
  // starts as soon as it is published, so the end date must be at least 2
  // calendar days after the start.
  if (end && !Number.isNaN(end.getTime())) {
    const startDay = start && !Number.isNaN(start.getTime()) && start.toISOString().slice(0, 10) > todayIso ? start.toISOString().slice(0, 10) : todayIso;
    const days = (Date.parse(end.toISOString().slice(0, 10)) - Date.parse(startDay)) / 86_400_000;
    if (days < 2 && end >= new Date(startDay)) {
      issues.push(err("schedule_too_short", "end_date", "Meta needs an ad set with a daily budget to run for at least 24 hours. Set the end date at least 2 days after the start (for a 1-day ad, end it the day after tomorrow), or leave the end date empty."));
    }
  }
  if (endRaw && cleanValue(brief.campaign_duration)) {
    issues.push(warn("duration_overridden", "campaign_duration", "You set both an end date and a duration — the end date is used."));
  }

  // ---- tracking ------------------------------------------------------------
  const tracking = norm(brief.conversion_tracking);
  if (tracking === "already installed") {
    issues.push(warn("tracking_unverified", "conversion_tracking", "We can't verify your pixel/tag from here. This campaign is optimised for landing-page views, not conversions, so it doesn't use it yet."));
  } else if (tracking === "not installed") {
    issues.push(warn("tracking_missing", "conversion_tracking", "Conversion tracking is not configured. The campaign can still run, but conversion measurement will be limited."));
  } else if (tracking === "not sure" || tracking === "__not_sure__" || tracking === "__ai_decide__") {
    issues.push(warn("tracking_unknown", "conversion_tracking", "Check whether the Meta Pixel is installed on your page — without it you can't see which clicks turn into leads or sales."));
  }

  // ---- goal adjustments ----------------------------------------------------
  if (["leads", "sales", "bookings"].includes(goal)) {
    issues.push(
      warn(
        "objective_adjusted",
        "desired_result",
        `"${cleanValue(brief.desired_result)}" is run as a Traffic campaign (optimised for landing-page views). True lead/sales optimisation needs a Meta Pixel event or Instant Form this app doesn't set up yet — your landing page is what captures the ${goal === "sales" ? "sale" : "lead"}.`
      )
    );
  }

  // ---- language ------------------------------------------------------------
  if (cleanValue(brief.language)) {
    issues.push(warn("language_copy_only", "language", `The ad copy is written in ${cleanValue(brief.language)}. Meta language targeting isn't applied — everyone in the chosen locations can see the ad.`));
  }

  // ---- exclusions ----------------------------------------------------------
  const exclusions = cleanList(brief.ad_exclusions);
  if (exclusions.length > 0) {
    issues.push(
      warn(
        "exclusions_not_enforced",
        "ad_exclusions",
        `AI will avoid messaging ${exclusions.join(", ")} in the creative, but Meta cannot technically block them with the current targeting — that needs a custom audience exclusion in Meta Ads Manager.`
      )
    );
  }

  return issues;
}

export const errorsOf = (issues: AdIssue[]) => issues.filter((i) => i.severity === "error");
export const warningsOf = (issues: AdIssue[]) => issues.filter((i) => i.severity === "warning");

/**
 * Turns a raw provider error (often a whole Zernio/Meta JSON blob) into the one
 * sentence a person can act on. Prefers Meta's own `error_user_msg`; otherwise
 * strips the JSON and trims. Pure, so it is unit-tested.
 */
export function friendlyAdError(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const user = text.match(/"error_user_msg"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (user?.[1]) return user[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
  const meta = text.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (meta?.[1]) return meta[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim().slice(0, 240);
  return text.replace(/\s+/g, " ").slice(0, 240);
}
