import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveBusinessContext, type BusinessContext } from "@/lib/business-context";
import {
  PILLAR_BRIEF,
  PILLAR_CTA,
  PILLAR_OBJECTIVE,
  formatHistory,
  planNextContent,
  repeatsHistory,
  resolveCta,
  type ContentFormat,
  type ContentPlan,
  type ContentPillar,
  type HistoryItem,
} from "@/lib/content-strategy";
import { planStrategicContent, type StrategicContentDraft } from "@/lib/social-ai";
import { validateOutbound } from "@/lib/brand-guard";
import {
  createZernioPost,
  uploadZernioMediaDirect,
  type ZernioKeyGroup,
  type ZernioMediaItem,
  type ZernioPostTarget,
} from "@/lib/zernio";

/**
 * Shared "strategy → content → publish" pipeline used by the recurring
 * scheduler and by the first-connection validation cycle, so both go through
 * exactly the same business-context retrieval, planning, history checks and
 * Zernio publishing.
 */

export const KEY_GROUP_BY_PLATFORM: Record<string, ZernioKeyGroup> = {
  instagram: "tiktok_instagram",
  tiktok: "tiktok_instagram",
  facebook: "google_meta",
  linkedin: "google_meta",
  youtube: "google_meta",
};

export interface ConnectionRef {
  platform: string;
  zernio_account_id: string | null;
}

/** Most recent content for THIS business, newest first — the anti-repetition memory. */
export async function loadContentHistory(admin: SupabaseClient, clientId: string, limit = 20): Promise<HistoryItem[]> {
  const { data } = await admin
    .from("social_posts")
    .select("content_pillar, topic, hook, cta, caption, product_name, content_type, created_at")
    .eq("client_id", clientId)
    .neq("status", "failed")
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  // Legacy rows stored a scheduler slot key ("auto_post_12_…") as the topic; that is not a topic.
  return (data ?? []).map((r) => ({ ...r, topic: r.topic && /^auto_(post|story)_/.test(r.topic) ? null : r.topic }));
}

export interface StrategicItem {
  plan: ContentPlan;
  draft: StrategicContentDraft;
  /** Caption with the CTA guaranteed present and hashtags appended. */
  caption: string;
  hashtagLine: string;
  retrievedSections: string[];
}

function finalCaption(draft: StrategicContentDraft, plan: ContentPlan, story: boolean): { caption: string; hashtagLine: string } {
  let body = draft.caption.trim();
  const ctaKey = plan.cta.toLowerCase().slice(0, 24);
  if (!story && !body.toLowerCase().includes(ctaKey)) body = `${body}\n\n${plan.cta}`;
  const hashtagLine = story ? "" : draft.hashtags.map((h) => `#${h}`).join(" ");
  return { caption: story ? body : hashtagLine ? `${body}\n\n${hashtagLine}` : body, hashtagLine };
}

/**
 * Plan + write one item. Retries once with the reason if the result repeats
 * recent content or breaks the business's own rules; if it still does, it
 * throws so nothing off-strategy is ever published.
 */
export async function createStrategicItem(params: {
  ctx: BusinessContext;
  history: HistoryItem[];
  format: ContentFormat;
  /** Overrides the goal-weighted pillar choice (the first-connection cycle opens with education). */
  forcePillar?: ContentPillar;
  /** A Story that supports an existing feed post keeps its pillar/product and teases its topic. */
  supports?: HistoryItem & { topic: string; hook: string; caption: string };
}): Promise<StrategicItem> {
  const { ctx, history, format, supports, forcePillar } = params;

  let plan = planNextContent(ctx, history, format);
  if (forcePillar) {
    plan = { ...plan, pillar: forcePillar, objective: PILLAR_OBJECTIVE[forcePillar], ctaIntent: PILLAR_CTA[forcePillar], cta: resolveCta(ctx, PILLAR_CTA[forcePillar], format) };
  }
  if (supports?.content_pillar && supports.content_pillar in PILLAR_OBJECTIVE) {
    const pillar = supports.content_pillar as ContentPillar;
    plan = {
      ...plan,
      pillar,
      objective: PILLAR_OBJECTIVE[pillar],
      productName: supports.product_name ?? plan.productName,
      cta: supports.cta ?? resolveCta(ctx, plan.ctaIntent, "story"),
    };
  }

  const retrieved = retrieveBusinessContext(ctx, {
    purpose: "content",
    query: [plan.productName, plan.audience, ctx.painPoints].filter(Boolean).join(" "),
    productName: plan.productName,
  });
  const historyBlock = formatHistory(history);

  let rejectedBecause: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = await planStrategicContent({
      companyName: ctx.businessName ?? "this business",
      businessContext: retrieved.text,
      format,
      pillar: plan.pillar,
      pillarBrief: PILLAR_BRIEF[plan.pillar],
      objective: plan.objective,
      productName: plan.productName,
      audience: plan.audience,
      cta: plan.cta,
      historyBlock,
      supports: supports ? { topic: supports.topic, hook: supports.hook, caption: supports.caption } : undefined,
      rejectedBecause,
      ownerPillars: ctx.contentPillars,
    });

    if (!draft.caption || !draft.topic) {
      rejectedBecause = "was missing a topic or caption";
      continue;
    }
    // A story is SUPPOSED to echo its feed post's topic, so only feed content is history-checked.
    const repeat = supports ? null : repeatsHistory(draft, history);
    if (repeat) {
      rejectedBecause = repeat;
      continue;
    }
    const built = finalCaption(draft, plan, format === "story");
    const violation = validateOutbound(`${built.caption} ${draft.hook}`, ctx);
    if (violation) {
      rejectedBecause = violation;
      continue;
    }
    return { plan, draft, ...built, retrievedSections: retrieved.reference.sections };
  }
  throw new Error(`Content rejected after retry: ${rejectedBecause}`);
}

export interface PublishInput {
  conns: ConnectionRef[];
  /** Per platform: may this go live (true) or must it stay a draft (false)? */
  mayPublish: (platform: string) => boolean;
  media: { base64: string; mimeType: string; kind: "image" | "video" };
  caption: string;
  story: boolean;
  filenameBase: string;
}

export interface PublishResult {
  anyPublish: boolean;
  mediaUrl: string;
  zernioPostIds: string[];
}

/**
 * Uploads the media once per Zernio key group and creates one post request per
 * (key group, publish/draft). Zernio accounts are scoped per API-key group:
 * Instagram/TikTok live under one Zernio user and Facebook/LinkedIn/YouTube
 * under another, so one POST /posts may not mix the two, and one request
 * cannot be both a draft and a live post.
 */
export async function publishToConnections(input: PublishInput): Promise<PublishResult> {
  const ext = input.media.mimeType.split("/")[1]?.split(";")[0] || (input.media.kind === "video" ? "mp4" : "png");
  const urlByGroup = new Map<ZernioKeyGroup, string>();
  const buckets = new Map<string, { group: ZernioKeyGroup; publish: boolean; targets: ZernioPostTarget[] }>();
  let anyPublish = false;

  for (const conn of input.conns) {
    const group = KEY_GROUP_BY_PLATFORM[conn.platform];
    if (!group || !conn.zernio_account_id) continue;
    let url = urlByGroup.get(group);
    if (!url) {
      const uploaded = await uploadZernioMediaDirect(group, {
        bytes: Buffer.from(input.media.base64, "base64"),
        filename: `${input.filenameBase}.${ext}`,
        contentType: input.media.mimeType,
      });
      url = uploaded.url ?? uploaded.mediaUrl;
      if (!url) throw new Error(`Zernio media upload returned no URL for ${group}`);
      urlByGroup.set(group, url);
    }
    const publish = input.mayPublish(conn.platform);
    if (publish) anyPublish = true;

    const item: ZernioMediaItem = { type: input.media.kind, url, mimeType: input.media.mimeType };
    const key = `${group}|${publish}`;
    const bucket = buckets.get(key) ?? { group, publish, targets: [] };
    bucket.targets.push({
      platform: conn.platform as ZernioPostTarget["platform"],
      accountId: conn.zernio_account_id,
      customMedia: [item],
      // contentType exists only in Instagram's and Facebook's platform data.
      ...(input.story && (conn.platform === "instagram" || conn.platform === "facebook")
        ? { platformSpecificData: { contentType: "story" } }
        : {}),
    });
    buckets.set(key, bucket);
  }

  const zernioPostIds: string[] = [];
  for (const { group, publish, targets } of buckets.values()) {
    const created = await createZernioPost(group, {
      content: input.story ? "" : input.caption,
      platforms: targets,
      ...(publish ? { publishNow: true } : { isDraft: true }),
    });
    const id = String(created?._id ?? created?.id ?? "");
    if (id) zernioPostIds.push(id);
  }

  return { anyPublish, mediaUrl: urlByGroup.values().next().value as string, zernioPostIds };
}

/** Row for the Content calendar / history, carrying WHY the post exists. */
export function historyRow(clientId: string, item: StrategicItem, extra: Record<string, unknown>) {
  return {
    client_id: clientId,
    topic: item.draft.topic,
    hook: item.draft.hook,
    caption: item.plan.format === "story" ? null : item.caption,
    cta: item.plan.cta,
    hashtags: item.draft.hashtags,
    content_pillar: item.plan.pillar,
    content_objective: item.plan.objective,
    target_audience: item.plan.audience ?? null,
    product_name: item.plan.productName ?? null,
    ...extra,
  };
}
