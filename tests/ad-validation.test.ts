import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsOf, validateAdBrief, warningsOf, UNSUPPORTED_PLATFORMS } from "../src/lib/ad-validation.ts";
import { buildAdPlan, buildCampaignBrief, type AdBriefInput } from "../src/lib/meta-ads.ts";
import { buildAdCreativePrompt, deterministicAdChecks, FOCUS_GUIDE } from "../src/lib/gemini.ts";

const good = (over: Partial<AdBriefInput> = {}): AdBriefInput => ({
  advertising_what: "AI lead follow-up automation for real estate companies",
  offer: "Free 15-minute consultation",
  why_choose_you: ["AI-powered"],
  desired_result: "Leads",
  post_ad_action: "Book a call",
  audience_description: "Real estate business owners and agents",
  age_range: "25–44",
  gender: "Everyone",
  interests: ["Real estate"],
  ad_countries: ["Pakistan"],
  ad_cities: ["Lahore"],
  daily_budget: 20,
  platforms: ["Facebook", "Instagram"],
  creative_focus: "Problem",
  ad_format: "Video",
  main_message: "Stop losing leads",
  ad_cta: "Book Now",
  landing_destination: "Calendly",
  landing_page_url: "https://example.com/book",
  conversion_tracking: "Already installed",
  ...over,
});

const codes = (b: AdBriefInput) => validateAdBrief(b, new Date("2026-01-10")).map((i) => `${i.severity}:${i.code}`);
const errs = (b: AdBriefInput) => errorsOf(validateAdBrief(b, new Date("2026-01-10"))).map((i) => i.code);

// ---- form ------------------------------------------------------------------

test("a complete, consistent brief has no blocking errors", () => {
  assert.deepEqual(errs(good()), []);
});

test("required fields are enforced", () => {
  assert.ok(errs(good({ advertising_what: "" })).includes("required"));
  assert.ok(errs(good({ desired_result: "" })).includes("required"));
  assert.ok(errs(good({ ad_countries: [] })).includes("required"));
  assert.ok(errs(good({ landing_destination: "" })).includes("required"));
});

test("invalid budget, age and dates are rejected", () => {
  assert.ok(errs(good({ daily_budget: 0 })).includes("bad_budget"));
  assert.ok(errs(good({ daily_budget: 99999 })).includes("bad_budget"));
  assert.ok(errs(good({ daily_budget: 0.5 })).includes("bad_budget"));
  assert.ok(errs(good({ age_range: "banana" })).includes("bad_age"));
  assert.ok(errs(good({ start_date: "2026-03-01", end_date: "2026-02-01" })).includes("bad_date"));
});

test("a URL is validated when present and a missing one is disclosed", () => {
  assert.ok(errs(good({ landing_page_url: "not a url" })).includes("bad_url"));
  assert.ok(codes(good({ landing_page_url: "" })).includes("warning:url_fallback"));
});

test("contradictory goal / action / destination is blocked, not silently resolved", () => {
  const conflict = good({ desired_result: "Leads", post_ad_action: "Buy", landing_destination: "Checkout" });
  assert.ok(errs(conflict).includes("conflict"));
  assert.ok(errs(good({ desired_result: "Sales", post_ad_action: "Fill a form" })).includes("conflict"));
  assert.ok(errs(good({ post_ad_action: "Buy", landing_destination: "Calendly", desired_result: "Sales" })).includes("conflict"));
});

test("existing audience needs a source; lookalike is refused without one", () => {
  assert.ok(errs(good({ has_existing_audience: "yes", existing_audience_sources: [] })).includes("audience_source"));
  assert.ok(errs(good({ has_existing_audience: "yes", existing_audience_sources: ["Customer list"], target_similar: "yes" })).includes("lookalike_unsupported"));
  // a source is accepted but disclosed as not enforceable
  assert.ok(codes(good({ has_existing_audience: "yes", existing_audience_sources: ["Customer list"] })).includes("warning:custom_audience_unsupported"));
});

// ---- platform / unsupported options ---------------------------------------

test("unsupported platforms can never enter the Meta flow", () => {
  for (const p of UNSUPPORTED_PLATFORMS) {
    assert.ok(errs(good({ platforms: [p] })).includes("unsupported_platform"), p);
  }
  // mixed: Meta stays, the others are dropped with a warning
  const mixed = validateAdBrief(good({ platforms: ["Facebook", "TikTok"] }));
  assert.equal(errorsOf(mixed).length, 0);
  assert.ok(warningsOf(mixed).some((w) => w.code === "unsupported_platform"));
});

test("unsupported formats, destinations, goals and actions are rejected", () => {
  assert.ok(errs(good({ ad_format: "Carousel" })).includes("unsupported_format"));
  assert.ok(errs(good({ ad_format: "Existing post" })).includes("unsupported_format"));
  assert.ok(errs(good({ landing_destination: "WhatsApp" })).includes("unsupported_destination"));
  assert.ok(errs(good({ landing_destination: "Phone" })).includes("unsupported_destination"));
  assert.ok(errs(good({ desired_result: "WhatsApp messages" })).includes("unsupported_goal"));
  assert.ok(errs(good({ post_ad_action: "Call" })).includes("unsupported_action"));
});

test("adjustments and non-enforceable answers are disclosed as warnings", () => {
  const c = codes(good({ ad_exclusions: ["Existing customers"], language: "Urdu", conversion_tracking: "Not installed", ad_cta: "WhatsApp" }));
  assert.ok(c.includes("warning:exclusions_not_enforced"));
  assert.ok(c.includes("warning:language_copy_only"));
  assert.ok(c.includes("warning:tracking_missing"));
  assert.ok(c.includes("warning:cta_adjusted"));
  assert.ok(c.includes("warning:objective_adjusted")); // Leads runs as Traffic
});

// ---- structured brief / Gemini context ------------------------------------

test("the structured brief gives every answer a named home", () => {
  const b = good({ ad_exclusions: ["Competitors"], ad_states: ["Punjab"] });
  const cb = buildCampaignBrief(b, buildAdPlan(b), "https://example.com/book");
  assert.equal(cb.business.offer, "Free 15-minute consultation");
  assert.deepEqual(cb.location.cities, ["Lahore"]);
  assert.deepEqual(cb.location.states, ["Punjab"]);
  assert.equal(cb.location.countries[0], "PK");
  assert.equal(cb.creative.focus, "Problem");
  assert.equal(cb.creative.format, "video");
  assert.equal(cb.cta.button, "BOOK_NOW");
  assert.equal(cb.cta.destination, "Calendly");
  assert.equal(cb.budget.currency, "ACCOUNT_CURRENCY");
  assert.deepEqual(cb.exclusions, ["Competitors"]);
});

test("the complete campaign context, AIDA, focus rule and CTA reach the Gemini prompt", () => {
  const b = good({ ad_exclusions: ["Competitors"] });
  const cb = buildCampaignBrief(b, buildAdPlan(b), "https://example.com/book");
  const prompt = buildAdCreativePrompt({
    platform: "facebook",
    advertisingWhat: "AI lead follow-up automation",
    offer: "Free 15-minute consultation",
    desiredResult: "Leads",
    targetLocation: "PK",
    dailyBudget: 20,
    audienceDescription: "Real estate business owners",
    preferredCta: "Book Now",
    landingPageUrl: "https://example.com/book",
    campaignBriefJson: JSON.stringify(cb),
    creativeFocus: "Problem",
    creativeFormat: "video",
    exclusions: ["Competitors"],
  });
  for (const needle of ["Free 15-minute consultation", "Lahore", "Calendly", "BOOK_NOW", "Stop losing leads", "Competitors"]) {
    assert.ok(prompt.includes(needle), `prompt is missing "${needle}"`);
  }
  for (const k of ["attention", "interest", "desire", "action"]) assert.ok(prompt.includes(`"${k}"`) || prompt.includes(`${k}:`));
  assert.ok(prompt.includes(FOCUS_GUIDE.problem));
  assert.ok(prompt.includes("video_prompt"));
  assert.ok(prompt.includes("hashtags"));
  assert.ok(/never write or invent a budget/i.test(prompt));
});

test("creative focus changes the instruction Gemini receives", () => {
  const mk = (creativeFocus: string) =>
    buildAdCreativePrompt({
      platform: "facebook", advertisingWhat: "x", offer: null, desiredResult: "Leads", targetLocation: "",
      dailyBudget: 1, audienceDescription: null, preferredCta: null, landingPageUrl: null, creativeFocus,
    });
  assert.notEqual(mk("Problem"), mk("Discount"));
  assert.ok(mk("Discount").includes("ONLY the discount supplied"));
  assert.ok(mk("Social proof").includes("do not fabricate testimonials"));
});

test("deterministic checks flag missing AIDA, wrong CTA and thin hashtags", () => {
  const ok = { aida: { attention: "a", interest: "b", desire: "c", action: "d" }, cta: "BOOK_NOW", hashtags: ["a", "b", "c"], body: "short", headlines: ["h"] };
  assert.ok(deterministicAdChecks(ok, "BOOK_NOW").every((c) => c.pass));
  const bad = { ...ok, aida: { ...ok.aida, desire: "" }, cta: "LEARN_MORE", hashtags: ["a"], body: "x".repeat(200) };
  const res = Object.fromEntries(deterministicAdChecks(bad, "BOOK_NOW").map((c) => [c.key, c.pass]));
  assert.deepEqual(res, { aida: false, cta: false, hashtags: false, primary_text: false });
});

test("regenerated creatives get increasing versions and never reuse one", async () => {
  const { nextCreativeVersion } = await import("../src/lib/meta-ads.ts");
  assert.equal(nextCreativeVersion([]), 1);
  assert.equal(nextCreativeVersion([1]), 2);
  assert.equal(nextCreativeVersion([1, 2, 3]), 4);
  assert.equal(nextCreativeVersion([1, null, undefined, 5]), 6);
});

test("audience and creative are compared against what Meta actually stored", async () => {
  const { compareDraftToMeta } = await import("../src/lib/meta-ads.ts");
  const sent = { ageMin: 25, ageMax: 44, gender: "all" as const, countries: ["PK"], cityKeys: ["111"], regionKeys: [], interestIds: ["6003"], expectedMedia: "video" as const };
  const metaOk = {
    targeting: {
      age_min: 25, age_max: 44,
      geo_locations: { cities: [{ key: "111", radius: 25 }] },
      flexible_spec: [{ interests: [{ id: "6003", name: "Real estate" }] }],
    },
  };
  assert.ok(compareDraftToMeta(sent, metaOk, [{ type: "video" }]).every((c) => c.ok));

  // Meta silently widened age, dropped the interest, stored an image instead of the video
  const metaBad = { targeting: { age_min: 18, age_max: 65, genders: [2], geo_locations: { countries: ["PK"] }, flexible_spec: [] } };
  const bad = Object.fromEntries(compareDraftToMeta(sent, metaBad, [{ type: "image" }]).map((c) => [c.key, c.ok]));
  assert.deepEqual(bad, { age: false, gender: false, location: false, interests: false, creative: false });

  // unreadable -> never a false pass
  assert.equal(compareDraftToMeta(sent, null, null).some((c) => c.ok && c.key === "audience"), false);
  assert.equal(compareDraftToMeta({ ...sent, gender: "female" }, { targeting: { age_min: 25, age_max: 44, genders: [2], geo_locations: { cities: [{ key: "111" }] }, flexible_spec: [{ interests: [{ id: "6003" }] }] } }, [{ type: "video" }]).every((c) => c.ok), true);
});

test("Facebook-only placements never include the deprecated video_feeds position", async () => {
  const { planPlacements } = await import("../src/lib/meta-ads.ts");
  const p = planPlacements(["Facebook"]);
  assert.ok(p && p.facebookPositions && !p.facebookPositions.includes("video_feeds"));
  assert.equal(planPlacements(["Facebook", "Instagram"]), null); // automatic placements
});

test("interest matching rejects entertainment look-alikes and prefers real categories", async () => {
  const { pickInterest } = await import("../src/lib/meta-ads.ts");
  const add = ["Interests", "Additional interests"];
  const real = pickInterest("Real estate", [
    { id: "1", name: "Real Estate (band)", path: add },
    { id: "2", name: "Century 21 Real Estate", path: add },
    { id: "3", name: "Property (industry)", path: ["Interests", "Property (industry)"] },
  ]);
  assert.equal(real?.id, "3");
  // exact base-name match wins
  assert.equal(pickInterest("Entrepreneurship", [
    { id: "a", name: "Social entrepreneurship", path: add },
    { id: "b", name: "Entrepreneurship (business and finance)", path: ["Interests", "Entrepreneurship (business and finance)"] },
  ])?.id, "b");
  // nothing usable -> null rather than a wrong pick
  assert.equal(pickInterest("Real estate", [{ id: "1", name: "Real Estate (band)" }]), null);
});

test("a schedule shorter than Meta's 24-hour minimum is rejected up front", () => {
  const today = new Date("2026-09-25T08:00:00Z");
  const codesFor = (b: AdBriefInput) => errorsOf(validateAdBrief(b, today)).map((i) => i.code);
  assert.ok(codesFor(good({ start_date: "2026-09-25", end_date: "2026-09-26" })).includes("schedule_too_short"));
  assert.ok(!codesFor(good({ start_date: "2026-09-25", end_date: "2026-09-27" })).includes("schedule_too_short"));
  assert.ok(!codesFor(good({ end_date: "" })).includes("schedule_too_short"));
});

test("raw provider error blobs become one readable sentence", async () => {
  const { friendlyAdError } = await import("../src/lib/ad-validation.ts");
  const raw = 'Zernio API /ads/create failed: 400 {"error":"Meta Ads API error (400; code 100, subcode 2490562): Facebook video feeds placement is deprecated","platformError":{"error_user_title":"Facebook video feeds placement is deprecated","error_user_msg":"Facebook video feeds placement is deprecated for this API version and cannot be selected. Please remove it from your targeting.","fbtrace_id":"X"}}';
  assert.equal(friendlyAdError(raw), "Facebook video feeds placement is deprecated for this API version and cannot be selected. Please remove it from your targeting.");
  assert.equal(friendlyAdError(null), "");
  assert.equal(friendlyAdError("plain failure"), "plain failure");
  assert.ok(friendlyAdError("x".repeat(1000)).length <= 240);
});
