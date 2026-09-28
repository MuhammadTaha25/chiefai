import type { BusinessContext } from "@/lib/business-context";

/**
 * Content strategy layer: Business Context → pillar/objective → topic → format
 * → post → CTA.
 *
 * Before this existed the scheduler was "generate a post → publish → generate
 * the next one": every run sent the same flat prompt to the model, so nothing
 * decided WHY a post existed and nothing stopped repeats. This module owns the
 * decisions that must not be left to a stateless prompt:
 *   - which pillar/objective the next post serves (goal-weighted, history-aware)
 *   - which product/service and audience it is about (rotated, focus-aware)
 *   - which CTA it carries (varied, and only ever the owner's own CTA/destination)
 *   - whether a generated result repeats recent content
 * The model then writes the topic/hook/caption INSIDE that plan.
 *
 * Pure functions only (no I/O) so behaviour is unit-testable.
 */

export type ContentPillar = "educational" | "problem_awareness" | "solution" | "trust" | "engagement" | "conversion";
export type ContentObjective = "education" | "problem_awareness" | "solution_education" | "trust" | "engagement" | "conversion";
export type ContentFormat = "image" | "video" | "story";
export type CtaIntent = "primary" | "save_share" | "comment" | "learn_more";

export const PILLAR_OBJECTIVE: Record<ContentPillar, ContentObjective> = {
  educational: "education",
  problem_awareness: "problem_awareness",
  solution: "solution_education",
  trust: "trust",
  engagement: "engagement",
  conversion: "conversion",
};

export const PILLAR_BRIEF: Record<ContentPillar, string> = {
  educational: "Teach something useful about the industry: a tip, how-to, common mistake or explanation. Not promotional.",
  problem_awareness: "Name a real problem or pain point this business's customers have, so the audience recognises themselves. Do not pitch yet.",
  solution: "Show how this business's actual product/service helps with that problem (use case, benefit, how it works). Only stated features.",
  trust: "Build credibility using ONLY the verified proof listed in the business context (certifications, results, experience, testimonials). Quote nothing that is not listed.",
  engagement: "Start a conversation: a question, opinion prompt or poll-style idea the audience will want to answer. Not promotional.",
  conversion: "Invite the audience to act on the business's primary call to action for a specific listed product/service. Never invent an offer.",
};

/** One row of recent content history for a single business (already tenant-scoped by the caller). */
export interface HistoryItem {
  content_pillar?: string | null;
  topic?: string | null;
  hook?: string | null;
  cta?: string | null;
  caption?: string | null;
  product_name?: string | null;
  content_type?: string | null;
}

export interface ContentPlan {
  pillar: ContentPillar;
  objective: ContentObjective;
  format: ContentFormat;
  productName?: string;
  audience?: string;
  cta: string;
  ctaIntent: CtaIntent;
  /** Recent topics/hooks/CTAs the model must not reuse. */
  avoid: { topics: string[]; hooks: string[]; ctas: string[] };
}

const ORDER: ContentPillar[] = ["educational", "problem_awareness", "solution", "trust", "engagement", "conversion"];

const BASE: Record<ContentPillar, number> = {
  educational: 3,
  problem_awareness: 2,
  solution: 2,
  trust: 1,
  engagement: 2,
  conversion: 1,
};

/** Goal → extra weight per pillar. Keys mirror the goal options on the business form. */
const GOAL_BOOST: Record<string, Partial<Record<ContentPillar, number>>> = {
  brand_awareness: { educational: 1, engagement: 1 },
  education: { educational: 3 },
  engagement: { engagement: 3 },
  lead_generation: { problem_awareness: 1, solution: 1, conversion: 2 },
  website_traffic: { solution: 1, conversion: 2 },
  bookings: { trust: 1, conversion: 2 },
  sales: { solution: 1, trust: 1, conversion: 2 },
  trust: { trust: 3 },
};

export const GOAL_OPTIONS = [
  { value: "brand_awareness", label: "Brand awareness" },
  { value: "education", label: "Education" },
  { value: "engagement", label: "Engagement" },
  { value: "lead_generation", label: "Lead generation" },
  { value: "website_traffic", label: "Website traffic" },
  { value: "bookings", label: "Bookings" },
  { value: "sales", label: "Sales" },
  { value: "trust", label: "Trust / credibility" },
] as const;

export const CTA_OPTIONS = [
  { value: "visit_website", label: "Visit website", needsDestination: "Website URL" },
  { value: "send_dm", label: "Send DM", needsDestination: null },
  { value: "whatsapp", label: "WhatsApp", needsDestination: "WhatsApp number or link" },
  { value: "call", label: "Call", needsDestination: "Phone number" },
  { value: "book_appointment", label: "Book appointment", needsDestination: "Booking URL (or leave empty to book by DM)" },
  { value: "request_quote", label: "Request quote", needsDestination: null },
  { value: "buy", label: "Buy", needsDestination: "Where to buy (URL)" },
  { value: "learn_more", label: "Learn more", needsDestination: "URL (optional)" },
  { value: "follow", label: "Follow", needsDestination: null },
  { value: "comment", label: "Comment", needsDestination: null },
  { value: "save_share", label: "Save / share", needsDestination: null },
] as const;

/** Target share of each pillar for this business. Trust is zero without owner-supplied proof — proof is never invented. */
export function pillarWeights(ctx: BusinessContext): Record<ContentPillar, number> {
  const w = { ...BASE };
  const apply = (goal: string | undefined, factor: number) => {
    for (const [p, v] of Object.entries(GOAL_BOOST[goal ?? ""] ?? {})) w[p as ContentPillar] += (v as number) * factor;
  };
  apply(ctx.primaryGoal, 1);
  apply(ctx.secondaryGoal, 0.5);
  if (!ctx.proof) w.trust = 0;
  if (!(ctx.products?.length || ctx.services)) w.solution = Math.min(w.solution, 1);
  const total = ORDER.reduce((s, p) => s + w[p], 0) || 1;
  for (const p of ORDER) w[p] = w[p] / total;
  return w;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ ]+/g, " ").replace(/\s+/g, " ").trim();

/** Pillar for the next post: biggest shortfall against the target mix over the recent window, never the same as the last post. */
export function choosePillar(ctx: BusinessContext, history: HistoryItem[]): ContentPillar {
  const weights = pillarWeights(ctx);
  const recent = history.slice(0, 12).filter((h) => h.content_pillar);
  const counts = Object.fromEntries(ORDER.map((p) => [p, 0])) as Record<ContentPillar, number>;
  for (const h of recent) if (h.content_pillar && h.content_pillar in counts) counts[h.content_pillar as ContentPillar]++;
  const n = recent.length || 1;
  const last = history[0]?.content_pillar;
  let best: ContentPillar = "educational";
  let bestScore = -Infinity;
  for (const p of ORDER) {
    if (weights[p] <= 0) continue;
    // weights[p] alone would always pick the heaviest pillar; the deficit is what produces the mix.
    const score = weights[p] - counts[p] / n + (last === p ? -10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Least recently used product, restricted to the owner's focus products when they set any. */
export function chooseProduct(ctx: BusinessContext, history: HistoryItem[]): string | undefined {
  const all = ctx.products ?? [];
  if (!all.length) return undefined;
  const focus = new Set((ctx.focusProducts ?? []).map((f) => f.toLowerCase()));
  const pool = focus.size ? all.filter((p) => focus.has(p.name.toLowerCase())) : all;
  const candidates = pool.length ? pool : all;
  const lastUsed = (name: string) => {
    const i = history.findIndex((h) => norm(h.product_name) === norm(name));
    return i === -1 ? Infinity : i;
  };
  // Infinity (never used) sorts first; Infinity - Infinity is NaN, so compare instead of subtracting.
  return [...candidates].sort((a, b) => {
    const x = lastUsed(a.name);
    const y = lastUsed(b.name);
    return x === y ? 0 : y > x ? 1 : -1;
  })[0].name;
}

function chooseAudience(ctx: BusinessContext, history: HistoryItem[]): string | undefined {
  const a = ctx.targetAudience ?? [];
  return a.length ? a[history.length % a.length] : undefined;
}

/** Only the owner's own CTA wording/destination is ever used; a missing destination degrades to "DM us", never to an invented contact. */
export function resolveCta(ctx: BusinessContext, intent: CtaIntent, format: ContentFormat = "image"): string {
  const dest = ctx.ctaDestination;
  switch (intent) {
    case "save_share":
      return format === "story" ? "Send this to someone who needs it." : "Save this post for later.";
    case "comment":
      return "Tell us in the comments.";
    case "learn_more":
      return dest && /^https?:\/\//i.test(dest) ? `Learn more: ${dest}` : "Learn more — send us a DM.";
    case "primary": {
      if (ctx.ctaPhrase) return ctx.ctaPhrase;
      switch (ctx.primaryCta) {
        case "visit_website":
          return dest || ctx.website ? `Visit ${dest || ctx.website}` : "Send us a DM to learn more.";
        case "whatsapp":
          return dest ? `WhatsApp us: ${dest}` : "Send us a DM to get in touch.";
        case "call":
          return dest ? `Call us: ${dest}` : "Send us a DM to get in touch.";
        case "book_appointment":
          return dest ? `Book here: ${dest}` : "Send us a DM to book.";
        case "request_quote":
          return "Send us a DM to request a quote.";
        case "buy":
          return dest ? `Get yours: ${dest}` : "Send us a DM to order.";
        case "learn_more":
          return dest ? `Learn more: ${dest}` : "Send us a DM to learn more.";
        case "follow":
          return "Follow us for more.";
        case "comment":
          return "Tell us in the comments.";
        case "save_share":
          return "Save and share this post.";
        default:
          return "Send us a DM to learn more.";
      }
    }
  }
}

export const PILLAR_CTA: Record<ContentPillar, CtaIntent> = {
  educational: "save_share",
  problem_awareness: "comment",
  solution: "primary",
  trust: "learn_more",
  engagement: "comment",
  conversion: "primary",
};

export function planNextContent(ctx: BusinessContext, history: HistoryItem[], format: ContentFormat): ContentPlan {
  const pillar = choosePillar(ctx, history);
  const ctaIntent = PILLAR_CTA[pillar];
  return {
    pillar,
    objective: PILLAR_OBJECTIVE[pillar],
    format,
    productName: chooseProduct(ctx, history),
    audience: chooseAudience(ctx, history),
    cta: resolveCta(ctx, ctaIntent, format),
    ctaIntent,
    avoid: {
      topics: history.slice(0, 15).map((h) => h.topic ?? "").filter(Boolean),
      hooks: history.slice(0, 15).map((h) => h.hook ?? "").filter(Boolean),
      ctas: history.slice(0, 5).map((h) => h.cta ?? "").filter(Boolean),
    },
  };
}

const STOPWORDS = new Set(["the", "and", "for", "you", "your", "can", "that", "with", "this", "are", "how", "what", "why", "from", "have", "will", "our", "not", "but", "all"]);
// Crude stemming so "automate"/"automated"/"automates" and "task"/"tasks" count as the same word.
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|e|s)$/, "") : w);
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem));

/** Jaccard word overlap — cheap, deterministic near-duplicate check for topics/hooks/captions. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** True when a generated topic/hook/caption is (near-)identical to something recent for this business. */
export function repeatsHistory(candidate: { topic?: string; hook?: string; caption?: string }, history: HistoryItem[]): string | null {
  for (const h of history.slice(0, 20)) {
    if (candidate.topic && h.topic && similarity(candidate.topic, h.topic) >= 0.6) return `topic repeats "${h.topic}"`;
    if (candidate.hook && h.hook && similarity(candidate.hook, h.hook) >= 0.7) return `hook repeats "${h.hook}"`;
    if (candidate.caption && h.caption && similarity(candidate.caption, h.caption) >= 0.75) return "caption repeats a recent caption";
  }
  return null;
}

/** Compact recent-history block for the prompt. */
export function formatHistory(history: HistoryItem[], max = 10): string {
  const rows = history.slice(0, max).map((h) => {
    const bits = [h.content_pillar, h.topic, h.hook ? `hook "${h.hook}"` : "", h.cta ? `cta "${h.cta}"` : ""].filter(Boolean);
    return `- ${bits.join(" | ")}`;
  });
  return rows.length ? `RECENT POSTS (do NOT repeat these topics, hooks, CTAs or angles):\n${rows.join("\n")}` : "";
}
