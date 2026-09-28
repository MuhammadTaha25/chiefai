import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One normalized, server-side view of "what is this client's business" for
 * every AI prompt (email, follow-up, replies, social, ads). Nothing is
 * duplicated: the source of truth stays `clients` (name, ICP, website) and
 * `client_social_profile` (everything the business-profile form collects).
 *
 * "business_id" in the product spec is `clients.id` here: one client = one
 * business, and every social connection / post / interaction already carries
 * client_id. That id is the ONLY isolation boundary for retrieval.
 *
 * Every field is optional — a client with a sparse profile must still work,
 * and a missing field must stay missing (the prompt is told not to invent it)
 * rather than being filled with a guess or a placeholder.
 *
 * Tenant safety: callers pass a clientId they resolved SERVER-SIDE (session
 * via getCurrentClient, or a webhook's own mailbox/connection lookup) — never
 * one taken from a request body. Every query below is also scoped by that id.
 */
export interface ProductEntry {
  name: string;
  description?: string;
  benefit?: string;
  price?: string;
  url?: string;
}

export interface BusinessContext {
  clientId: string;
  businessName?: string;
  description?: string;
  industry?: string;
  services?: string;
  targetAudience?: string[];
  targetMarket?: string;
  painPoints?: string;
  offers?: string;
  pricingInfo?: string;
  uniqueSellingPoints?: string;
  faqs?: string;
  brandVoice?: string[];
  language?: string;
  preferredCtas?: string[];
  mustSay?: string;
  mustNotSay?: string;
  negativeConstraints?: string;
  website?: string;
  bookingMethod?: string;
  contactMethod?: string;
  businessHours?: string;
  location?: string;
  products?: ProductEntry[];
  /** Product/service names that deserve the most attention. Empty = all equally. */
  focusProducts?: string[];
  desiredOutcomes?: string;
  whyChooseUs?: string;
  /** Proof the owner explicitly supplied. The ONLY factual proof the AI may cite. */
  proof?: string;
  tagline?: string;
  visualStyle?: string;
  brandColors?: string[];
  primaryGoal?: string;
  secondaryGoal?: string;
  primaryCta?: string;
  ctaDestination?: string;
  ctaPhrase?: string;
  emojiStyle?: string;
  captionStyles?: string[];
  contentPillars?: string[];
  brandKeywords?: string;
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};
const list = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const items = v.map((x) => String(x).trim()).filter(Boolean);
  return items.length ? items : undefined;
};

export function parseProducts(v: unknown): ProductEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ProductEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = clean(r.name);
    if (!name) continue;
    out.push({ name, description: clean(r.description), benefit: clean(r.benefit), price: clean(r.price), url: clean(r.url) });
  }
  return out.length ? out : undefined;
}

export async function getClientBusinessContext(admin: SupabaseClient, clientId: string): Promise<BusinessContext> {
  const [{ data: client }, { data: profile }] = await Promise.all([
    admin.from("clients").select("id, company_name, icp_industry, icp_location").eq("id", clientId).maybeSingle(),
    admin.from("client_social_profile").select("*").eq("client_id", clientId).maybeSingle(),
  ]);

  return {
    clientId,
    businessName: clean(client?.company_name),
    description: clean(profile?.business_description),
    industry: clean(profile?.niche) ?? clean(client?.icp_industry),
    services: clean(profile?.services),
    targetAudience: list(profile?.target_audience),
    targetMarket: clean(client?.icp_location),
    painPoints: clean(profile?.pain_points),
    offers: clean(profile?.offers),
    pricingInfo: clean(profile?.pricing_info),
    uniqueSellingPoints: clean(profile?.usps),
    faqs: clean(profile?.faqs),
    brandVoice: list(profile?.tone_of_voice),
    language: clean(profile?.language),
    preferredCtas: list(profile?.preferred_ctas),
    mustSay: clean(profile?.must_say),
    mustNotSay: clean(profile?.must_not_say),
    negativeConstraints: clean(profile?.negative_constraints),
    website: clean(profile?.website),
    bookingMethod: clean(profile?.booking_method),
    contactMethod: clean(profile?.contact_method),
    businessHours: clean(profile?.business_hours),
    location: clean(profile?.location),
    products: parseProducts(profile?.products),
    focusProducts: list(profile?.focus_products),
    desiredOutcomes: clean(profile?.desired_outcomes),
    whyChooseUs: clean(profile?.why_choose_us),
    proof: clean(profile?.proof),
    tagline: clean(profile?.tagline),
    visualStyle: clean(profile?.visual_style),
    brandColors: list(profile?.brand_colors),
    primaryGoal: clean(profile?.primary_goal),
    secondaryGoal: clean(profile?.secondary_goal),
    primaryCta: clean(profile?.primary_cta),
    ctaDestination: clean(profile?.cta_destination),
    ctaPhrase: clean(profile?.cta_phrase),
    emojiStyle: clean(profile?.emoji_style),
    captionStyles: list(profile?.caption_styles),
    contentPillars: list(profile?.content_pillars),
    brandKeywords: clean(profile?.brand_keywords),
  };
}

// ---------------------------------------------------------------------------
// Retrieval
//
// The context is already tenant-scoped by getClientBusinessContext(clientId).
// Retrieval decides WHICH parts of that one business's knowledge go into a
// given prompt — not the whole profile every time — by (a) selecting sections
// by purpose and (b) ranking products/services against the customer's message
// or the planned topic. It is deliberately lexical, not vector search: one
// business has a handful of products and a few FAQs, so overlap ranking is
// deterministic, testable, and needs no embedding store; a vector layer would
// only add a second place where tenant isolation can leak.
// ---------------------------------------------------------------------------

export type ContextPurpose = "content" | "comment" | "dm" | "general";

export interface RetrievalOptions {
  purpose: ContextPurpose;
  /** Customer message, post caption, or planned topic — used to rank products/FAQs. */
  query?: string;
  /** Force a specific product/service (content planning picks one up front). */
  productName?: string;
}

export interface RetrievedContext {
  text: string;
  /** What grounded the answer — stored with the interaction (a reference, not the content). */
  reference: { clientId: string; purpose: ContextPurpose; sections: string[]; products: string[] };
}

type Row = { section: string; label: string; value: string | undefined; purposes: ContextPurpose[] | "all" };

const STOP = new Set(["the", "and", "for", "you", "your", "are", "can", "does", "how", "what", "with", "this", "that", "have", "from", "will", "our", "about", "get", "want", "need"]);
const tokens = (s: string | undefined) =>
  (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

function scoreText(queryTokens: Set<string>, text: string | undefined, weight: number): number {
  if (!queryTokens.size) return 0;
  let n = 0;
  for (const t of new Set(tokens(text))) if (queryTokens.has(t)) n += weight;
  return n;
}

export function rankProducts(ctx: BusinessContext, opts: RetrievalOptions): ProductEntry[] {
  const all = ctx.products ?? [];
  if (!all.length) return [];
  if (opts.productName) {
    const wanted = opts.productName.trim().toLowerCase();
    const hit = all.filter((p) => p.name.toLowerCase() === wanted);
    if (hit.length) return hit;
  }
  const q = new Set(tokens(opts.query));
  const scored = all
    .map((p) => ({
      p,
      s: scoreText(q, p.name, 3) + scoreText(q, p.description, 1) + scoreText(q, p.benefit, 1),
    }))
    .sort((a, b) => b.s - a.s);
  // Keep only products close to the best match, so a word every product shares ("automation")
  // does not drag unrelated products into a specific question.
  const best = scored[0]?.s ?? 0;
  const matched = scored.filter((x) => x.s > 0 && x.s >= best * 0.6).slice(0, 3).map((x) => x.p);
  if (matched.length) return matched;
  // No product mentioned. Replies see the whole (small) catalogue so "what do
  // you offer?" is answerable; content leads with the owner's focus products.
  if (opts.purpose === "content" && ctx.focusProducts?.length) {
    const focus = new Set(ctx.focusProducts.map((f) => f.toLowerCase()));
    const f = all.filter((p) => focus.has(p.name.toLowerCase()));
    if (f.length) return f;
  }
  return all.slice(0, 8);
}

/** FAQs are free text ("Q: … A: …"); keep only the Q/A blocks that overlap the query when there are several. */
function relevantFaqs(faqs: string | undefined, query: string | undefined): string | undefined {
  if (!faqs) return undefined;
  const blocks = faqs.split(/\n\s*\n|(?=\nQ:)/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 3 || !query) return faqs;
  const q = new Set(tokens(query));
  const hit = blocks.filter((b) => scoreText(q, b, 1) > 0);
  return (hit.length ? hit : blocks.slice(0, 3)).join("\n\n");
}

function productLine(p: ProductEntry): string {
  const parts = [`${p.name}${p.description ? `: ${p.description}` : ""}`];
  if (p.benefit) parts.push(`Main benefit: ${p.benefit}`);
  // An explicit "not provided" is what stops the model inventing a price.
  parts.push(`Price: ${p.price ?? "NOT PROVIDED — do not state or estimate one"}`);
  if (p.url) parts.push(`URL: ${p.url}`);
  return `- ${parts.join(" | ")}`;
}

export function retrieveBusinessContext(ctx: BusinessContext, opts: RetrievalOptions): RetrievedContext {
  const products = rankProducts(ctx, opts);
  const replying = opts.purpose === "comment" || opts.purpose === "dm";
  const rows: Row[] = [
    { section: "profile", label: "Business", value: ctx.businessName, purposes: "all" },
    { section: "profile", label: "Industry", value: ctx.industry, purposes: "all" },
    { section: "profile", label: "What we do", value: ctx.description, purposes: "all" },
    { section: "profile", label: "Location / service area", value: ctx.location, purposes: "all" },
    { section: "profile", label: "Website", value: ctx.website, purposes: "all" },
    { section: "profile", label: "Market", value: ctx.targetMarket, purposes: ["content", "general"] },
    { section: "products", label: "Services (as written by the owner)", value: products.length ? undefined : ctx.services, purposes: "all" },
    { section: "audience", label: "Ideal customers", value: ctx.targetAudience?.join(", "), purposes: "all" },
    { section: "audience", label: "Customer problems / pain points", value: ctx.painPoints, purposes: "all" },
    { section: "audience", label: "Customer desired outcomes", value: ctx.desiredOutcomes, purposes: "all" },
    { section: "positioning", label: "Why customers choose us", value: ctx.whyChooseUs, purposes: "all" },
    { section: "positioning", label: "What makes us different", value: ctx.uniqueSellingPoints, purposes: "all" },
    { section: "positioning", label: "VERIFIED proof (only claims listed here may be cited as proof)", value: ctx.proof, purposes: ["content", "dm", "general"] },
    { section: "offers", label: "Offers", value: ctx.offers, purposes: "all" },
    { section: "offers", label: "Pricing", value: ctx.pricingInfo, purposes: "all" },
    { section: "faqs", label: "Common questions & answers", value: relevantFaqs(ctx.faqs, opts.query), purposes: "all" },
    { section: "brand", label: "Brand voice", value: ctx.brandVoice?.join(", "), purposes: "all" },
    { section: "brand", label: "Language", value: ctx.language, purposes: "all" },
    { section: "brand", label: "Tagline", value: ctx.tagline, purposes: ["content", "general"] },
    { section: "brand", label: "Visual style", value: ctx.visualStyle, purposes: ["content", "general"] },
    { section: "brand", label: "Brand colors", value: ctx.brandColors?.join(", "), purposes: ["content", "general"] },
    { section: "brand", label: "Emoji style", value: ctx.emojiStyle, purposes: "all" },
    { section: "brand", label: "Caption styles", value: ctx.captionStyles?.join(", "), purposes: ["content", "general"] },
    { section: "brand", label: "Brand keywords", value: ctx.brandKeywords, purposes: ["content", "general"] },
    { section: "brand", label: "Must say", value: ctx.mustSay, purposes: "all" },
    { section: "brand", label: "Must NOT say", value: ctx.mustNotSay, purposes: "all" },
    { section: "brand", label: "Never do", value: ctx.negativeConstraints, purposes: "all" },
    { section: "goals", label: "Primary social goal", value: ctx.primaryGoal, purposes: ["content", "general"] },
    { section: "goals", label: "Secondary social goal", value: ctx.secondaryGoal, purposes: ["content", "general"] },
    { section: "cta", label: "Primary call to action", value: ctx.primaryCta, purposes: "all" },
    { section: "cta", label: "CTA destination", value: ctx.ctaDestination, purposes: "all" },
    { section: "cta", label: "Preferred CTA phrase", value: ctx.ctaPhrase, purposes: "all" },
    { section: "cta", label: "Other CTAs", value: ctx.preferredCtas?.join(", "), purposes: ["content", "general"] },
    { section: "contact", label: "How to book", value: ctx.bookingMethod, purposes: "all" },
    { section: "contact", label: "Contact method", value: ctx.contactMethod, purposes: "all" },
    { section: "contact", label: "Business hours", value: ctx.businessHours, purposes: replying ? "all" : ["general"] },
  ];

  const active = rows.filter((r) => r.value && (r.purposes === "all" || r.purposes.includes(opts.purpose)));
  const lines = active.map((r) => `${r.label}: ${r.value}`);
  if (products.length) {
    const at = active.findIndex((r) => r.section === "audience");
    lines.splice(at >= 0 ? at : lines.length, 0, `Products / services:\n${products.map(productLine).join("\n")}`);
  }
  if (!lines.length) {
    return { text: "", reference: { clientId: ctx.clientId, purpose: opts.purpose, sections: [], products: [] } };
  }

  const sections = Array.from(new Set(active.map((r) => r.section)));
  if (products.length) sections.push("products");

  const text = `BUSINESS CONTEXT (the only facts you may state about this business):
${lines.join("\n")}

Grounding rules:
- Treat anything not listed above as UNKNOWN. Never invent prices, discounts, offers, guarantees, services, features, policies, results, testimonials, awards or claims.
- A price may only be stated if it appears above next to that exact product/service. "NOT PROVIDED" means there is no price to give.
- If asked about something not covered above (e.g. a service, integration or price that is not listed), say you're not sure and offer to connect them with the team — do not say yes and do not guess.
- Match the brand voice and language above; obey "Must NOT say" and "Never do" strictly.`;

  return {
    text,
    reference: { clientId: ctx.clientId, purpose: opts.purpose, sections, products: products.map((p) => p.name) },
  };
}

/**
 * Whole-profile prompt block for the flows that predate purpose-based
 * retrieval (cold email, follow-ups, voice, ads). Same rules, no narrowing.
 */
export function formatBusinessContext(ctx: BusinessContext | null | undefined): string {
  if (!ctx) return "";
  return retrieveBusinessContext(ctx, { purpose: "general" }).text;
}

/** Safe QA log line — proves which context loaded without logging any content. */
export function describeContextForLog(ctx: BusinessContext): string {
  return `client_id=${ctx.clientId} business_name=${ctx.businessName ?? "-"} industry=${ctx.industry ?? "-"} services_set=${Boolean(
    ctx.services || ctx.products?.length
  )} context_loaded=true`;
}
