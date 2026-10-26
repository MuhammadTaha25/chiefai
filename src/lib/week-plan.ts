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
  cta: string;
}

/** What the model adds for one entry. */
export interface WeekIdeaDraft {
  key: string;
  topic: string;
  hook: string;
  visualIdea: string;
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
      cta: resolveCta(ctx, PILLAR_CTA[best], format),
    });
    picked.unshift({ content_pillar: best, product_name: productName ?? null, topic: null, hook: null });
  });
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
// A visual idea has to be something a camera or a picture can show. These words name an idea, not a scene.
const ABSTRACT_VISUAL = /\b(concept|the impact of|the importance of|the idea of|the power of|productivity|synergy|digital transformation|bottleneck|workflow optimi[sz]ation)\b/i;

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
    const repeat = repeatsHistory({ topic: d.topic, hook: d.hook }, history);
    if (repeat) return `entry ${s.key}: ${repeat}`;
    for (const o of seen) {
      if (similarity(d.topic, o.topic) >= 0.5) return `entries ${o.key} and ${d.key} have nearly the same topic`;
      if (similarity(d.hook, o.hook) >= 0.6) return `entries ${o.key} and ${d.key} have nearly the same hook`;
      const open = (h: string) => words(h).slice(0, 3).join(" ").toLowerCase();
      if (open(d.hook) === open(o.hook)) return `entries ${o.key} and ${d.key} open with the same words`;
    }
    seen.push(d);
  }
  return null;
}

/** A skeleton entry together with its validated draft. */
export function mergeWeek(skeleton: WeekSkeletonEntry[], drafts: WeekIdeaDraft[]): WeekEntry[] {
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  return skeleton.map((s) => {
    const d = byKey.get(s.key)!;
    return { ...s, topic: d.topic.trim(), hook: d.hook.trim(), visualIdea: d.visualIdea.trim() };
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
