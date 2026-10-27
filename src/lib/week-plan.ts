import type { BusinessContext } from "@/lib/business-context";
import {
  PILLAR_CTA,
  PILLAR_OBJECTIVE,
  chooseProduct,
  pillarWeights,
  repeatsHistory,
  resolveCta,
  similarity,
  type ContentFormat,
  type ContentPillar,
  type HistoryItem,
} from "@/lib/content-strategy";
import type { PlannedItem } from "@/lib/social-schedule";

/**
 * Weekly content plan: the week's posts are decided ONCE (pillar, product, call to action by code; title, hook and a
 * concrete visual idea by the model), and each day's post is then made from that day's entry instead of inventing a
 * topic on the day. Pure functions only (no I/O), so every rule here is unit-testable.
 */

export type WeekFormat = "image" | "carousel" | "video";

/** What the code decides for one planned post BEFORE the model writes anything. */
export interface WeekSkeletonEntry {
  key: string;
  weekday: number;
  slot: number;
  format: WeekFormat;
  pillar: ContentPillar;
  productName?: string;
  audience?: string;
  /** The one customer problem this post is about; different for every post of the week as far as the list allows. */
  painPoint?: string;
  /** For trust posts: HOW trust is built. Only ways that need no testimonial or case study (none exist yet) are used. */
  trustMechanism?: string;
  cta: string;
}

/** The kinds of angle a post can take. Two posts of one week never share an angle, even on the same problem. */
export const ANGLES = ["checklist", "demonstration", "misconception", "comparison", "decision_guide", "objection", "moment_story", "audience_question"] as const;

/** Trust without testimonials: show how it works, what happens when it fails, what it is not for. */
export const TRUST_MECHANISMS = ["demonstration", "process_transparency", "limitation_and_safeguard", "technical_explanation"] as const;
export const TRUST_BRIEF: Record<string, string> = {
  demonstration: "show a (clearly fictional, illustrative) step-by-step example of how it works",
  process_transparency: "explain how the work is done: what is set up first, what is tested, what the customer decides",
  limitation_and_safeguard: "explain what happens when the system cannot answer or gets it wrong, and when a person takes over",
  technical_explanation: "explain in plain words why it works this way, without tool names or jargon",
};

/** What the model adds for one entry. */
export interface WeekIdeaDraft {
  key: string;
  topic: string;
  hook: string;
  visualIdea: string;
  /** One of ANGLES. Required from the model; older stored plans do not have it. */
  angle?: string;
}

/** One stored entry of the week plan. */
export interface WeekEntry extends WeekSkeletonEntry, WeekIdeaDraft {}

export const entryKey = (weekday: number, slot: number) => `${weekday}:${slot}`;

/** ISO date (YYYY-MM-DD) of the Monday of the week containing `date` (whose weekday, Mon=0, is given). */
export function weekStartOf(date: string, weekday: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weekday);
  return d.toISOString().slice(0, 10);
}

/** First minute of Sunday evening from which the NEXT week's plan is made. */
export const PLAN_MINUTE_SUNDAY = 20 * 60;

/** The weeks that must have a plan right now: this week always; next week too from Sunday evening on. */
export function weeksToPlan(clock: { date: string; weekday: number; minutes: number }): string[] {
  const current = weekStartOf(clock.date, clock.weekday);
  const weeks = [current];
  if (clock.weekday === 6 && clock.minutes >= PLAN_MINUTE_SUNDAY) {
    const next = new Date(`${current}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    weeks.push(next.toISOString().slice(0, 10));
  }
  return weeks;
}

/** The business's own list of customer problems, split into single problems ("a; b; c." → ["a","b","c"]). */
export function painPointList(painPoints: string | undefined): string[] {
  return (painPoints ?? "")
    .split(/[;\n]+|\.\s+/)
    .map((p) => p.trim().replace(/\.$/, "").trim())
    .filter((p) => p.length > 2);
}

const ORDER: ContentPillar[] = ["educational", "problem_awareness", "solution", "trust", "engagement", "conversion"];

/** About one post in four may be an offer (conversion); never fewer than one for a week of three or more posts. */
export function conversionCap(postCount: number): number {
  return postCount >= 3 ? Math.max(1, Math.floor(postCount / 4)) : 0;
}

/**
 * Pillar, product, audience and CTA for every planned post of the week, chosen so the WEEK as a whole follows the
 * business's goal mix: the deficit logic of the daily planner, run over the week's own picks as they accumulate.
 */
export function planWeekSkeleton(ctx: BusinessContext, history: HistoryItem[], items: PlannedItem[]): WeekSkeletonEntry[] {
  const posts = items
    .filter((it) => it.kind === "post" && (it.format === "image" || it.format === "carousel" || it.format === "video"))
    .sort((a, b) => a.weekday - b.weekday || a.slot - b.slot);
  const weights = pillarWeights(ctx);
  const cap = conversionCap(posts.length);
  const audiences = ctx.targetAudience ?? [];
  const problems = painPointList(ctx.painPoints);
  // Start the rotation where the last plan could have ended, so consecutive weeks do not open with the same problem.
  const problemOffset = history.length % Math.max(1, problems.length);
  const picked: HistoryItem[] = []; // newest first, like `history`
  const out: WeekSkeletonEntry[] = [];

  posts.forEach((it, i) => {
    const hist = [...picked, ...history];
    const recent = hist.slice(0, 12).filter((h) => h.content_pillar);
    const counts = Object.fromEntries(ORDER.map((p) => [p, 0])) as Record<ContentPillar, number>;
    for (const h of recent) if (h.content_pillar && h.content_pillar in counts) counts[h.content_pillar as ContentPillar]++;
    const n = recent.length || 1;
    const last = hist[0]?.content_pillar;
    const conversionsThisWeek = out.filter((e) => e.pillar === "conversion").length;

    let best: ContentPillar = "educational";
    let bestScore = -Infinity;
    for (const p of ORDER) {
      if (weights[p] <= 0) continue;
      if (p === "conversion" && conversionsThisWeek >= cap) continue;
      const score = weights[p] - counts[p] / n + (last === p ? -10 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    const trustsSoFar = out.filter((e) => e.pillar === "trust").length;
    const format: ContentFormat = it.format === "video" ? "video" : "image";
    const productName = chooseProduct(ctx, hist);
    out.push({
      key: entryKey(it.weekday, it.slot),
      weekday: it.weekday,
      slot: it.slot,
      format: it.format as WeekFormat,
      pillar: best,
      productName,
      audience: audiences.length ? audiences[(history.length + i) % audiences.length] : undefined,
      painPoint: problems.length ? problems[(problemOffset + i) % problems.length] : undefined,
      trustMechanism: best === "trust" ? TRUST_MECHANISMS[(history.length + trustsSoFar) % TRUST_MECHANISMS.length] : undefined,
      cta: resolveCta(ctx, PILLAR_CTA[best], format),
    });
    picked.unshift({ content_pillar: best, product_name: productName ?? null, topic: null, hook: null });
  });
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
// A visual idea has to be something a camera or a picture can show. These words name an idea, not a scene.
// Stock-photo scenes: a person at a desk with a laptop and coffee shows nothing about the post. Allowed only when
// something is visibly HAPPENING (a ringing phone, a pile of messages ...).
const STOCK_PROPS = /\b(desk|laptop|coffee|workspace|tablet|modern office|glass window|calendar|notebook)\b/i;
const HAPPENING = /\b(ring(s|ing)?|buzz(es|ing)?|missed|unanswered|pil(e|es|ing)|stack(s|ed)?|overflow(s|ing)?|notifications?|waiting|queue|messages?|blink(s|ing)?|flash(es|ing)?|flood(s|ed|ing)?|crowd(s|ed)?|lights up|unread|inbox|timer|clock)\b/i;
// A hook speaks to the reader's own situation. A company introduction or a tool name is not a hook.
const COMPANY_HOOK = /^(we|our|at [a-z0-9 ]+, we)\b/i;
const JARGON = /\b(n8n|rag|api|llm|saas|crm|workflow automation platform|webhook|built-for-you|done-for-you|built for you|done for you)\b/i;
const ABSTRACT_VISUAL = /\b(concept|the impact of|the importance of|the idea of|the power of|productivity|synergy|digital transformation|bottleneck|workflow optimi[sz]ation)\b/i;

// Numbers that claim a RESULT or a saving (hours saved, percentages, money) need evidence we do not have.
const CLAIM_NUMBER = /(\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred|thousand)\s*(hours?|percent|times|x)\b|\d\s*%|[$£€]\s*\d|\bthousands?\b|\bmillions?\b)/i;
// A bare feature statement is not a hook ("You can automatically ...").
const FEATURE_HOOK = /^(you can|our|we|with [a-z ]+ you can|get|try|introducing|meet)\b/i;
// Tidy "finished" scenes show the solved state; only solution/conversion posts may.
const SOLVED_PROPS = /\b(whiteboard|completed tasks?|check ?marks?|dashboard|chart|graph|spreadsheet|trophy)\b/i;

// What a visual is built from. Two scenes from the same family read as the same picture even with different jobs.
const SCENE_FAMILIES: Record<string, RegExp> = {
  ringing_phone: /\b(phone|smartphone|telephone|call|calls|ringing|buzz\w*|lights? up)\b/i,
  night: /\b(night|dusk|dark|dim\w*|after (closing|hours)|evening|late)\b/i,
  walking_away: /\b(walk\w*|leaving|leaves|heads?|out of|toward|to (their|his|her) car|doorway)\b/i,
  unread_pile: /\b(unread|notifications?|pil(e|es)|stack|messages?)\b/i,
};
/** At most this many posts of one week may share a scene family (a phone is allowed twice, night or walking away once). */
const FAMILY_LIMIT: Record<string, number> = { ringing_phone: 2, night: 1, walking_away: 1, unread_pile: 2 };
// A conversion hook has to point to a next step; asking a mood question is not an offer.
const NEXT_STEP = /\b(see|map|book|talk|show|try|walk|look|find out|ask|demo|message|dm|start|reply|let's|lets|free|call us|check)\b/i;

/**
 * Returns why a set of model drafts is not good enough (so the model can be told and retry), or null when it is fine.
 * Rules: one complete draft per planned post; no repeated or near-identical topics/hooks inside the week or against
 * recent history; no two hooks opening with the same three words; a visual idea that is a concrete scene.
 */
export function validateWeekDrafts(skeleton: WeekSkeletonEntry[], drafts: WeekIdeaDraft[], history: HistoryItem[]): string | null {
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  const seen: WeekIdeaDraft[] = [];
  for (const s of skeleton) {
    const d = byKey.get(s.key);
    if (!d) return `there was no entry for ${s.key}`;
    if (!d.topic.trim() || !d.hook.trim() || !d.visualIdea.trim()) return `entry ${s.key} was missing a topic, hook or visual idea`;
    if (words(d.visualIdea).length < 6) return `the visual idea for ${s.key} was too short to be a real scene`;
    if (ABSTRACT_VISUAL.test(d.visualIdea)) return `the visual idea for ${s.key} describes an idea, not something that can be seen`;
    if (words(d.hook).length > 22) return `the hook for ${s.key} was too long`;
    if (COMPANY_HOOK.test(d.hook.trim())) return `the hook for ${s.key} introduces the company instead of speaking to the reader's situation`;
    if (CLAIM_NUMBER.test(d.hook) || CLAIM_NUMBER.test(d.topic)) return `the hook or topic for ${s.key} states a number of hours, a percentage or an amount, which we cannot prove`;
    if (FEATURE_HOOK.test(d.hook.trim())) return `the hook for ${s.key} announces a feature instead of starting from the reader's situation or a real question`;
    if (!d.angle || !(ANGLES as readonly string[]).includes(d.angle)) return `entry ${s.key} needs an angle from: ${ANGLES.join(", ")}`;
    if ((s.pillar !== "solution" && s.pillar !== "conversion") && SOLVED_PROPS.test(d.visualIdea)) return `the visual idea for ${s.key} shows the finished solution (a whiteboard, chart or checklist) instead of the moment the post is about`;
    if (s.pillar === "conversion" && !NEXT_STEP.test(d.hook)) return `the conversion hook for ${s.key} gives no next step to take`;
    if (JARGON.test(d.hook)) return `the hook for ${s.key} uses technical jargon a customer would not use`;
    if (STOCK_PROPS.test(d.visualIdea) && !HAPPENING.test(d.visualIdea)) return `the visual idea for ${s.key} is a stock-photo scene (a person at a desk or laptop) where nothing is happening`;
    const repeat = repeatsHistory({ topic: d.topic, hook: d.hook }, history);
    if (repeat) return `entry ${s.key}: ${repeat}`;
    for (const o of seen) {
      if (d.angle && d.angle === o.angle) return `entries ${o.key} and ${d.key} use the same angle (${d.angle}); each post of the week needs a different one`;
      if (similarity(d.topic, o.topic) >= 0.5) return `entries ${o.key} and ${d.key} have nearly the same topic`;
      if (similarity(d.hook, o.hook) >= 0.6) return `entries ${o.key} and ${d.key} have nearly the same hook`;
      const open = (h: string) => words(h).slice(0, 3).join(" ").toLowerCase();
      if (open(d.hook) === open(o.hook)) return `entries ${o.key} and ${d.key} open with the same words`;
    }
    seen.push(d);
  }
  // Visual variety across the whole week: families of scenes and near-identical pictures.
  for (const [fam, re] of Object.entries(SCENE_FAMILIES)) {
    const hits = skeleton.filter((sk) => re.test(byKey.get(sk.key)?.visualIdea ?? "")).map((sk) => sk.key);
    if (hits.length > (FAMILY_LIMIT[fam] ?? 2)) return `too many visuals (${hits.join(", ")}) are the same kind of scene (${fam.replace("_", " ")}); show different actions and settings`;
  }
  for (let i = 0; i < seen.length; i++)
    for (let j = i + 1; j < seen.length; j++)
      if (similarity(seen[i].visualIdea, seen[j].visualIdea) >= 0.4) return `entries ${seen[i].key} and ${seen[j].key} show nearly the same picture`;
  return null;
}

/** A skeleton entry together with its validated draft. */
export function mergeWeek(skeleton: WeekSkeletonEntry[], drafts: WeekIdeaDraft[]): WeekEntry[] {
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  return skeleton.map((s) => {
    const d = byKey.get(s.key)!;
    return { ...s, topic: d.topic.trim(), hook: d.hook.trim(), visualIdea: d.visualIdea.trim(), angle: d.angle };
  });
}

/** Stored JSON → entries, dropping anything malformed (a bad row must never break posting; the caller falls back). */
export function parseWeekEntries(value: unknown): WeekEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WeekEntry[] = [];
  for (const v of value) {
    const e = v as Partial<WeekEntry> | null;
    if (!e || typeof e !== "object") continue;
    if (typeof e.key !== "string" || typeof e.topic !== "string" || typeof e.hook !== "string" || typeof e.visualIdea !== "string") continue;
    if (!e.topic.trim() || !e.hook.trim() || !e.visualIdea.trim()) continue;
    if (!e.pillar || !(e.pillar in PILLAR_OBJECTIVE) || typeof e.cta !== "string") continue;
    if (e.format !== "image" && e.format !== "carousel" && e.format !== "video") continue;
    out.push(e as WeekEntry);
  }
  return out;
}
