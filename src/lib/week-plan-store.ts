import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveBusinessContext, type BusinessContext } from "@/lib/business-context";
import { PILLAR_BRIEF, formatHistory, type HistoryItem } from "@/lib/content-strategy";
import { planWeekIdeas } from "@/lib/social-ai";
import type { PlannedItem } from "@/lib/social-schedule";
import { mergeWeek, parseWeekEntries, planWeekSkeleton, validateWeekDrafts, type WeekEntry } from "@/lib/week-plan";
import { validateOutbound } from "@/lib/brand-guard";

/**
 * Storage and generation of the weekly content plan (table social_week_plan, one row per client and week).
 * Every failure here returns null / the stored value: the scheduler then simply falls back to deciding the topic on
 * the day, so a planning problem can never stop a post from going out.
 */

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function loadWeekPlan(admin: SupabaseClient, clientId: string, weekStart: string): Promise<WeekEntry[] | null> {
  const { data, error } = await admin.from("social_week_plan").select("entries").eq("client_id", clientId).eq("week_start", weekStart).maybeSingle<{ entries: unknown }>();
  if (error || !data) return null;
  const entries = parseWeekEntries(data.entries);
  return entries.length ? entries : null;
}

/**
 * Makes the plan for one week if there is none yet: code picks pillar/product/CTA per post, the model writes titles,
 * hooks and visual ideas, the result is checked (one retry with the reason), then stored. Returns the entries, or null
 * when planning failed or there was nothing to plan.
 */
export async function ensureWeekPlan(
  admin: SupabaseClient,
  params: { clientId: string; weekStart: string; ctx: BusinessContext; history: HistoryItem[]; items: PlannedItem[] },
): Promise<WeekEntry[] | null> {
  const existing = await loadWeekPlan(admin, params.clientId, params.weekStart);
  if (existing) return existing;

  const skeleton = planWeekSkeleton(params.ctx, params.history, params.items);
  if (!skeleton.length) return null;

  let rejectedBecause: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let drafts;
    try {
      drafts = await planWeekIdeas({
        companyName: params.ctx.businessName ?? "this business",
        businessContext: retrieveBusinessContext(params.ctx, { purpose: "content", query: [params.ctx.painPoints, params.ctx.services].filter(Boolean).join(" ") }).text,
        historyBlock: formatHistory(params.history, 15),
        entries: skeleton.map((s) => ({
          key: s.key,
          dayName: DAY_NAMES[s.weekday] ?? `day ${s.weekday}`,
          format: s.format,
          pillar: s.pillar,
          pillarBrief: PILLAR_BRIEF[s.pillar],
          productName: s.productName,
          audience: s.audience,
          painPoint: s.painPoint,
        })),
        rejectedBecause,
      });
    } catch (err) {
      rejectedBecause = `the request failed (${(err as Error).message})`;
      continue;
    }
    const why = validateWeekDrafts(skeleton, drafts, params.history);
    if (why) {
      rejectedBecause = why;
      continue;
    }
    // The business's own wording rules (restricted phrases, unsupported prices) apply to the plan as well.
    const violation = drafts.map((d) => validateOutbound(`${d.topic} ${d.hook}`, params.ctx)).find(Boolean);
    if (violation) {
      rejectedBecause = violation;
      continue;
    }
    const entries = mergeWeek(skeleton, drafts);
    const { error } = await admin.from("social_week_plan").insert({ client_id: params.clientId, week_start: params.weekStart, entries });
    if (error && (error as { code?: string }).code !== "23505") return null; // not stored: fall back to day-by-day
    // 23505 = another run stored the week first: use whatever it stored.
    return (await loadWeekPlan(admin, params.clientId, params.weekStart)) ?? entries;
  }
  return null;
}
