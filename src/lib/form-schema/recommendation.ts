import { FormValues } from "./types";

export interface RecommendationRow {
  label: string;
  value: string;
}

export interface Recommendation {
  rows: RecommendationRow[];
  reasons: string[];
}

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    if (Array.isArray(v) && v.length) return v.join(", ");
    if (typeof v === "string" && v.trim()) return v;
  }
  return "Let AI decide";
}

/** Deterministic synthesis of the lead-gen form into a plain-English target profile. Not a live AI call — just reflects the answers back clearly so the client can sanity-check before we search. */
export function buildLeadRecommendation(v: FormValues): Recommendation {
  const rows: RecommendationRow[] = [
    // business_category describes the CLIENT's own business, not the industry of the leads being
    // searched for — falling back to it here used to show it under "Industry" whenever target_industries
    // was left empty, wrongly implying the search would target companies like the client's own, when the
    // actual search instead lets Gemini infer the target industry from "what you sell".
    { label: "Industry", value: firstNonEmpty(v.target_industries, "Let AI decide based on what you sell") },
    { label: "Company size", value: firstNonEmpty(v.company_size, "Any size") },
    { label: "Revenue", value: firstNonEmpty(v.annual_revenue, "Any") },
    { label: "Location", value: firstNonEmpty(v.target_countries) },
    { label: "Target person", value: firstNonEmpty(v.contact_titles) },
    { label: "Growth signals", value: firstNonEmpty(v.buying_signals, v.recent_activity, "Any relevant signal") },
    { label: "Lead quality", value: firstNonEmpty(v.lead_quality, "Good") },
  ];

  const reasons: string[] = [];
  if (v.target_industries) {
    reasons.push("These industries closely match the product or service you described.");
  }
  if (v.company_size) {
    reasons.push(`Companies of this size (${firstNonEmpty(v.company_size)}) typically match your typical deal size.`);
  }
  if (v.contact_titles) {
    reasons.push("This is the role most likely to make the buying decision for what you sell.");
  }
  if (v.buying_signals || v.recent_activity) {
    reasons.push("These signals suggest a company is actively ready to buy right now, not just a fit on paper.");
  }
  if (reasons.length < 3) {
    reasons.push("Where you left a field as 'Not sure' or 'Let AI decide', we filled it with the safest, broadest option so you don't miss good leads.");
  }

  return { rows, reasons: reasons.slice(0, 5) };
}

export function buildAdsRecommendation(v: FormValues): Recommendation {
  const rows: RecommendationRow[] = [
    { label: "Platforms", value: firstNonEmpty(v.platforms) },
    { label: "Audience", value: firstNonEmpty(v.audience_description, v.interests) },
    { label: "Age", value: firstNonEmpty(v.age_range, "All ages") },
    { label: "Campaign goal", value: firstNonEmpty(v.desired_result) },
    { label: "Budget", value: v.daily_budget ? `${v.daily_budget}/day (in your Meta ad account's currency)` : "Not set" },
    { label: "Sends people to", value: firstNonEmpty(v.landing_destination) },
    { label: "Main offer", value: firstNonEmpty(v.offer) },
    { label: "Call to action", value: firstNonEmpty(v.ad_cta, v.post_ad_action) },
    { label: "Creative", value: firstNonEmpty(v.ad_format, "Let AI decide") },
  ];

  const reasons: string[] = [];
  if (v.desired_result) reasons.push(`Everything below is built around getting you more ${String(v.desired_result).toLowerCase()}.`);
  if (v.platforms) reasons.push("These platforms are where your described audience is most likely to be active.");
  if (v.daily_budget) reasons.push(`${v.daily_budget}/day is charged in your Meta ad account's currency. If the audience is estimated too small, we tell you exactly what was broadened.`);
  if (reasons.length < 3) reasons.push("Fields left as 'Let AI decide' were filled with the option most likely to perform well for this type of business.");

  return { rows, reasons: reasons.slice(0, 5) };
}
