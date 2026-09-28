import crypto from "crypto";

/**
 * Server-only. Zernio (docs.zernio.com) is the aggregator this app already
 * uses to connect Instagram/Facebook/etc (see /api/zernio/connect). This
 * wraps the inbox/comment/DM endpoints needed for the auto-reply automation
 * that was previously n8n-only — moving it in-app the same way the Mailgun
 * email flow was moved earlier in this project.
 *
 * Two Zernio API keys, two account groups (see /api/zernio/connect for why):
 * google_meta covers facebook/linkedin/youtube, tiktok_instagram covers
 * instagram/tiktok. A webhook subscription is per-key (registered once,
 * "one endpoint serves many profiles" per Zernio's own docs), not per-client
 * — the event payload's `account.accountId` is what we resolve to a client.
 */
import { pickInterest } from "./meta-ads.ts";

const ZERNIO_BASE_URL = process.env.ZERNIO_BASE_URL;

export type ZernioKeyGroup = "google_meta" | "tiktok_instagram";

const API_KEY_BY_GROUP: Record<ZernioKeyGroup, string | undefined> = {
  google_meta: process.env.ZERNIO_API_KEY_GOOGLE_META,
  tiktok_instagram: process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM,
};

function apiKeyFor(group: ZernioKeyGroup): string {
  const key = API_KEY_BY_GROUP[group];
  if (!key) throw new Error(`No Zernio API key configured for group "${group}"`);
  return key;
}

async function zernioFetch<T = unknown>(group: ZernioKeyGroup, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ZERNIO_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKeyFor(group)}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zernio API ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** docs.zernio.com/webhooks — one subscription per key group, events pushed centrally. */
export async function createZernioWebhook(group: ZernioKeyGroup, name: string, url: string, secret: string) {
  return zernioFetch(group, "/webhooks/settings", {
    method: "POST",
    body: JSON.stringify({
      name,
      url,
      secret,
      events: ["comment.received", "message.received"],
    }),
  });
}

/**
 * Public reply to a comment — verified against Zernio's own published
 * OpenAPI spec (zernio.com/openapi.json), NOT the docs.zernio.com prose
 * pages, which named a different (nonexistent) path that 404'd on a live
 * call. Real path: POST /v1/inbox/comments/{postId}, with the comment being
 * replied to passed as `commentId` in the BODY, not the URL.
 */
export function replyToComment(
  group: ZernioKeyGroup,
  accountId: string,
  postId: string,
  commentId: string,
  message: string
) {
  return zernioFetch(group, `/inbox/comments/${postId}`, {
    method: "POST",
    body: JSON.stringify({ accountId, message, commentId }),
  });
}

/** Private (DM) reply to a comment — Instagram allows exactly one, within 7 days. */
export function privateReplyToComment(
  group: ZernioKeyGroup,
  accountId: string,
  postId: string,
  commentId: string,
  message: string
) {
  return zernioFetch(group, `/inbox/comments/${postId}/${commentId}/private-reply`, {
    method: "POST",
    body: JSON.stringify({ accountId, message }),
  });
}

/** Reply within an existing DM conversation — body field is `message`, not `text`. */
export function sendDirectMessage(group: ZernioKeyGroup, accountId: string, conversationId: string, message: string) {
  return zernioFetch(group, `/inbox/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ accountId, message }),
  });
}

// ---------------------------------------------------------------------------
// Post creation / publishing
//
// Shapes verified against Zernio's own published OpenAPI spec
// (zernio.com/openapi.json), not the prose docs. `platforms` is REQUIRED for
// anything that is not a draft, and each entry needs both the platform name
// and the Zernio accountId that will publish it.
// ---------------------------------------------------------------------------

export type ZernioPostPlatform = "instagram" | "facebook" | "linkedin" | "tiktok" | "youtube";

export interface ZernioMediaItem {
  /**
   * Optional: Zernio infers the media type from the URL extension when this is
   * omitted, and REJECTS a type that contradicts that extension with a 400.
   * Omit it for URL-based media; set it for raw uploads where there is no
   * extension to infer from.
   */
  type?: "image" | "video" | "gif" | "document";
  /** A media item whose url is null/missing/empty is silently DROPPED by Zernio. */
  url: string;
  altText?: string;
  mimeType?: string;
  filename?: string;
  thumbnail?: string;
}

export interface ZernioPostTarget {
  platform: ZernioPostPlatform;
  accountId: string;
  /** Per-platform caption override. Falls back to the top-level content. */
  customContent?: string;
  /** Per-platform media override (falls back to the top-level mediaItems). */
  customMedia?: ZernioMediaItem[];
  /**
   * Per-platform options. Instagram accepts `contentType: "story"` (anything
   * else is a feed post, and a single video becomes a Reel automatically);
   * Facebook accepts `contentType: "story"` or `"reel"`.
   */
  platformSpecificData?: Record<string, unknown>;
}

export interface CreateZernioPostParams {
  content: string;
  platforms: ZernioPostTarget[];
  mediaItems?: ZernioMediaItem[];
  /** Required unless publishNow is true (or a draft). */
  scheduledFor?: string;
  /** Publish synchronously in this request instead of scheduling. */
  publishNow?: boolean;
  /** Save as a draft. Some platforms reject drafts outright. */
  isDraft?: boolean;
  timezone?: string;
  title?: string;
}

export interface ZernioCreatedPost {
  _id?: string;
  id?: string;
  status?: string;
  [key: string]: unknown;
}

export function createZernioPost(group: ZernioKeyGroup, params: CreateZernioPostParams) {
  const body: Record<string, unknown> = {
    content: params.content,
    platforms: params.platforms.map((p) => ({
      platform: p.platform,
      accountId: p.accountId,
      ...(p.customContent ? { customContent: p.customContent } : {}),
      ...(p.customMedia?.length ? { customMedia: p.customMedia } : {}),
      ...(p.platformSpecificData ? { platformSpecificData: p.platformSpecificData } : {}),
    })),
  };
  if (params.mediaItems?.length) body.mediaItems = params.mediaItems;
  if (params.scheduledFor) body.scheduledFor = params.scheduledFor;
  if (params.publishNow) body.publishNow = true;
  if (params.isDraft) body.isDraft = true;
  if (params.timezone) body.timezone = params.timezone;
  if (params.title) body.title = params.title;

  return publishZernioPost(group, body);
}

/**
 * POST /posts with 207 handling.
 *
 * Zernio answers 207 (not an error status) when the post was SAVED but the
 * inline publish did not fully succeed — including the case where NO platform
 * published. `!res.ok` is false for 207, so the old shared helper treated a
 * completely failed publish as a success and callers recorded
 * status:"published" for a post that was never live.
 *
 * A 207 therefore throws here with the per-platform reason, so the caller
 * records an honest failure instead of a green tick. The post itself still
 * exists on Zernio (it is in the response's `post`), which the message says.
 */
async function publishZernioPost(group: ZernioKeyGroup, body: Record<string, unknown>): Promise<ZernioCreatedPost> {
  const res = await fetch(`${ZERNIO_BASE_URL}/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKeyFor(group)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Zernio API /posts failed: ${res.status} ${text.slice(0, 300)}`);
  }

  let json: {
    post?: ZernioCreatedPost;
    platformResults?: { platform?: string; status?: string; error?: string | null }[];
    message?: string;
    error?: string;
  } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON 2xx body: fall through with an empty object rather than
    // throwing, since the post may well have been created.
  }

  if (res.status === 207) {
    const failures = (json.platformResults ?? [])
      .filter((r) => r.status === "failed" || r.error)
      .map((r) => `${r.platform ?? "unknown"}: ${r.error ?? r.status ?? "failed"}`)
      .join("; ");
    throw new Error(
      `Zernio saved the post but publishing did not succeed (HTTP 207${json.post?.status ? `, post status "${json.post.status}"` : ""})` +
        `${failures ? ` — ${failures}` : json.error ? ` — ${json.error}` : json.message ? ` — ${json.message}` : ""}`
    );
  }

  return json.post ?? (json as ZernioCreatedPost);
}

export function listZernioPosts(group: ZernioKeyGroup, params: { accountId?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.accountId) qs.set("accountId", params.accountId);
  if (params.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return zernioFetch<{ posts?: ZernioCreatedPost[] }>(group, `/posts${suffix}`);
}

/**
 * Direct (server-side) media upload. `contentType` is a closed enum on
 * Zernio's side — anything outside it is rejected with a 400, so callers must
 * pass one of the listed MIME types rather than guessing from the filename.
 */
export async function uploadZernioMediaDirect(
  group: ZernioKeyGroup,
  file: { bytes: Uint8Array; filename: string; contentType: string }
): Promise<{ url?: string; mediaUrl?: string; [key: string]: unknown }> {
  const form = new FormData();
  // Cast: a Uint8Array is a valid BlobPart at runtime; the DOM lib's generic
  // ArrayBufferLike parameter is what trips the compiler, not the value.
  form.append("file", new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }), file.filename);
  // Direct fetch (not zernioFetch) because zernioFetch forces
  // Content-Type: application/json, which makes Zernio reject the multipart
  // body with "Invalid multipart form data". Let fetch set the boundary.
  const res = await fetch(`${ZERNIO_BASE_URL}/media/upload-direct`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyFor(group)}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zernio media upload failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Paid ads — campaign + ad set + ad, created in one atomic call.
//
// Shapes verified against Zernio's published OpenAPI spec (zernio.com/openapi.json),
// POST /v1/ads/create, which is the endpoint that builds the WHOLE Meta
// hierarchy: 1 campaign (objective) -> 1 ad set (budget, schedule, geo, age,
// gender, placements, optimization) -> 1 ad (headline, primary text,
// description, CTA, link, image).
//
// The earlier implementation posted to POST /v1/ads/campaigns with a payload of
// budget/headlines/landingPageUrl — fields that endpoint does not accept (it
// takes {accountId, adAccountId, name, goal}). It therefore created a campaign
// with no ad set and no ad under it: nothing was deliverable, and the user's
// targeting, creative angle and landing page never reached Meta at all.
// ---------------------------------------------------------------------------

export interface CreateMetaAdParams {
  /** Zernio SocialAccount id (the ads-variant connection). */
  accountId: string;
  /** Meta ad account id, already prefixed `act_<n>`. */
  adAccountId: string;
  campaignName: string;
  adSetName: string;
  adName: string;
  /** Zernio/Meta campaign objective. */
  goal: string;
  optimizationGoal?: string;
  billingEvent?: string;
  /** Daily budget in the ad account's own currency (whole units). */
  dailyBudget: number;
  /** `adset` = ABO (Meta default), `campaign` = CBO. */
  budgetLevel?: "adset" | "campaign";
  /** Publish live (ACTIVE) or hold paused for review. */
  status?: "ACTIVE" | "PAUSED";
  headline: string;
  body: string;
  description?: string;
  callToAction: string;
  linkUrl: string;
  imageUrl?: string;
  imageHash?: string;
  /**
   * Video creative — MUTUALLY EXCLUSIVE with imageUrl/imageHash. Give a public
   * `url` and Zernio downloads it, uploads it via chunked transfer and blocks
   * until Meta reports the video as ready; or an `id` to reuse a video already
   * in the ad account's library. MP4 H.264/AAC, 3s-30min, 75KB-500MB.
   */
  video?: { url?: string; id?: string; thumbnailUrl?: string };
  countries: string[];
  /**
   * City-level geo. Meta targets cities by OPAQUE KEY only (see searchMetaGeo).
   * NOTE the spelling differs between Zernio endpoints: the create payload
   * wants `distance_unit`, while /ads/targeting/reach-estimate rejects that and
   * wants `distanceUnit` — sending the wrong one fails with "radius and
   * distanceUnit must be set together".
   */
  cities?: { key: string; radius?: number; distance_unit?: "kilometer" | "mile" }[];
  /** Region (state/province) keys, same opaque-key rule as cities. */
  regions?: { key: string }[];
  ageMin?: number;
  ageMax?: number;
  gender?: "all" | "male" | "female";
  interests?: { id: string; name: string }[];
  languages?: number[];
  placements?: Record<string, unknown>;
  startDate?: string;
  endDate?: string;
  /** Required by Meta whenever the ad set can reach EU users (DSA art. 26). */
  dsaBeneficiary?: string;
  dsaPayor?: string;
  /** Free-form passthrough for values the caller wants recorded verbatim. */
  platformSpecificData?: Record<string, unknown>;
  /**
   * Idempotency-Key header. /ads/create is NOT idempotent at the platform
   * level: a blind retry creates a second campaign, ad set and ad — i.e. it
   * spends twice. Sending a stable key makes a retry replay the first response.
   */
  idempotencyKey?: string;
}

export interface CreatedAd {
  /** Meta campaign id. */
  platformCampaignId?: string;
  /** Meta ad set id. */
  platformAdSetId?: string;
  /** Meta ad id. */
  platformAdId?: string;
  creativeId?: string;
  /**
   * ZERNIO's own ad document id (24-char hex) — distinct from the Meta ad id.
   * This is the id the preview endpoint takes, so it has to be kept alongside
   * the platform ids or previews can't be rendered later.
   */
  zernioAdId?: string;
  ad?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** Creates a full, deliverable Meta ad: campaign -> ad set -> ad + creative. */
export async function createMetaAd(group: ZernioKeyGroup, params: CreateMetaAdParams): Promise<CreatedAd> {
  const hasCityOrRegion = Boolean(params.cities?.length || params.regions?.length);
  const targeting: Record<string, unknown> = {
    // Meta rejects "locations overlap" when a city and its own country are
    // targeted together, so the country list is only sent when no city/region
    // is being targeted. A city is the more specific instruction anyway.
    countries: hasCityOrRegion ? [] : params.countries,
    // Meta's Marketing API requires this field on every ad-set create; 0 keeps
    // the audience exactly as the user targeted it instead of letting Meta
    // silently broaden it.
    advantageAudience: 0,
  };
  if (params.cities?.length) targeting.cities = params.cities;
  if (params.regions?.length) targeting.regions = params.regions;
  if (params.ageMin || params.ageMax) {
    targeting.ageMin = params.ageMin ?? 18;
    targeting.ageMax = params.ageMax ?? 65;
  }
  if (params.gender && params.gender !== "all") targeting.gender = params.gender;
  if (params.interests?.length) targeting.interests = params.interests;
  if (params.languages?.length) targeting.languages = params.languages;
  if (params.placements) targeting.placements = params.placements;

  const body: Record<string, unknown> = {
    accountId: params.accountId,
    adAccountId: params.adAccountId,
    // `name` is the campaign name (required); the explicit level names keep the
    // three entities distinguishable in Meta Ads Manager.
    name: params.campaignName,
    campaignName: params.campaignName,
    adSetName: params.adSetName,
    adName: params.adName,
    goal: params.goal,
    budgetAmount: params.dailyBudget,
    budgetType: "daily",
    budgetLevel: params.budgetLevel ?? "adset",
    status: params.status ?? "ACTIVE",
    campaignStatus: params.status ?? "ACTIVE",
    headline: params.headline,
    body: params.body,
    callToAction: params.callToAction,
    linkUrl: params.linkUrl,
    ...targeting,
  };
  if (params.description) body.description = params.description;
  if (params.imageUrl) body.imageUrl = params.imageUrl;
  if (params.imageHash) body.imageHash = params.imageHash;
  // Never send an image and a video together: Meta rejects the combination and
  // the video is the more specific instruction.
  if (params.video?.url || params.video?.id) body.video = params.video;
  if (params.optimizationGoal) body.optimizationGoal = params.optimizationGoal;
  if (params.billingEvent) body.billingEvent = params.billingEvent;
  if (params.startDate) body.startDate = params.startDate;
  if (params.endDate) body.endDate = params.endDate;
  if (params.dsaBeneficiary) body.dsaBeneficiary = params.dsaBeneficiary;
  if (params.dsaPayor) body.dsaPayor = params.dsaPayor;
  if (params.platformSpecificData) body.platformSpecificData = params.platformSpecificData;

  const json = await zernioFetch<{
    ad?: Record<string, unknown>;
    ads?: Record<string, unknown>[];
    platformCampaignId?: string;
    platformAdSetId?: string;
    message?: string;
  }>(group, "/ads/create", {
    method: "POST",
    headers: params.idempotencyKey ? { "Idempotency-Key": params.idempotencyKey } : undefined,
    body: JSON.stringify(body),
  });

  const ad = json.ad ?? json.ads?.[0];
  const read = (key: string): string | undefined => {
    const v = (ad?.[key] ?? json[key as keyof typeof json]) as unknown;
    return typeof v === "string" && v ? v : undefined;
  };

  return {
    platformCampaignId: read("platformCampaignId"),
    platformAdSetId: read("platformAdSetId"),
    platformAdId: read("platformAdId"),
    creativeId: read("creativeId"),
    zernioAdId: read("_id") ?? read("id"),
    ad,
    raw: json as Record<string, unknown>,
  };
}

/**
 * Renders Meta's OWN preview of an existing ad, per placement.
 *
 * `adId` here is ZERNIO's ad document id (24-char hex), NOT the Meta ad id —
 * pass `CreatedAd.zernioAdId`.
 *
 * Each entry's `html` is a Meta `<iframe>` snippet. Only the iframe `src` is
 * returned: the raw snippet is third-party HTML and rendering it verbatim with
 * dangerouslySetInnerHTML would be an injection vector for no benefit.
 */
export async function getAdPreviews(
  group: ZernioKeyGroup,
  zernioAdId: string,
  formats: string[]
): Promise<{ format: string; src: string }[]> {
  try {
    const qs = formats.length ? `?formats=${encodeURIComponent(formats.join(","))}` : "";
    const r = await zernioFetch<{ previews?: { format?: string; html?: string | null }[] }>(
      group,
      `/ads/${encodeURIComponent(zernioAdId)}/preview${qs}`
    );
    return (r.previews ?? [])
      .map((p) => {
        const match = (p.html ?? "").match(/src\s*=\s*["']([^"']+)["']/i);
        return { format: String(p.format ?? "preview"), src: match?.[1] ?? "" };
      })
      .filter((p) => p.src.startsWith("https://"));
  } catch {
    // A preview is a convenience, never a reason to fail a launch.
    return [];
  }
}

/** Meta's ad_format values worth showing for a Facebook/Instagram campaign. */
export const DEFAULT_AD_PREVIEW_FORMATS = [
  "MOBILE_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "FACEBOOK_STORY_MOBILE",
];

/** Pauses or resumes a campaign. On Meta this one switch cascades to its ad sets and ads. */
export function setAdCampaignStatus(
  group: ZernioKeyGroup,
  campaignId: string,
  status: "active" | "paused",
  platform: string
): Promise<Record<string, unknown>> {
  return zernioFetch(group, `/ads/campaigns/${encodeURIComponent(campaignId)}/status`, {
    method: "PUT",
    body: JSON.stringify({ status, platform }),
  });
}

/** Deletes a campaign (and, per Zernio, the ads under it). Used to discard a draft. */
export function deleteAdCampaign(
  group: ZernioKeyGroup,
  campaignId: string,
  accountId: string
): Promise<{ deleted?: boolean; adCount?: number }> {
  return zernioFetch(
    group,
    `/ads/campaigns/${encodeURIComponent(campaignId)}?accountId=${encodeURIComponent(accountId)}`,
    { method: "DELETE" }
  );
}

/**
 * Uploads an AI-generated image into the Meta ad account's image library so it
 * can be used as `imageUrl` on /ads/create — the image Gemini returns is raw
 * base64 with no public URL, which Meta cannot fetch.
 */
export async function uploadAdImage(
  group: ZernioKeyGroup,
  params: { accountId: string; adAccountId: string; imageBase64: string; filename?: string }
): Promise<{ hash?: string; url?: string }> {
  const res = await zernioFetch<{ image?: { hash?: string; url?: string } }>(group, "/ads/images", {
    method: "POST",
    body: JSON.stringify({
      accountId: params.accountId,
      adAccountId: params.adAccountId,
      // Accepts raw base64 or a full data URL; strip the prefix ourselves so
      // both shapes are safe to pass through.
      imageBase64: params.imageBase64.replace(/^data:[^;]+;base64,/, ""),
      filename: params.filename ?? "infomist-ad-image.jpg",
    }),
  });
  return res.image ?? {};
}

/**
 * Read-only audience-size estimate for the ad set we are about to create.
 * Used as a sanity check before spending: Meta rejects an absurdly narrow
 * audience at create time, and a very narrow one silently burns budget.
 * Returns null when the estimate is unavailable (never blocks the launch).
 */
export async function estimateAudienceReach(
  group: ZernioKeyGroup,
  params: {
    accountId: string;
    adAccountId: string;
    spec: Record<string, unknown>;
    optimizationGoal?: string;
  }
): Promise<{ lower: number | null; upper: number | null; estimateReady: boolean | null } | null> {
  try {
    const r = await zernioFetch<{
      available?: boolean;
      lower?: number | null;
      upper?: number | null;
      estimateReady?: boolean | null;
    }>(group, "/ads/targeting/reach-estimate", {
      method: "POST",
      body: JSON.stringify({
        accountId: params.accountId,
        adAccountId: params.adAccountId,
        spec: params.spec,
        ...(params.optimizationGoal ? { optimizationGoal: params.optimizationGoal } : {}),
      }),
    });
    if (r.available === false) return null;
    return { lower: r.lower ?? null, upper: r.upper ?? null, estimateReady: r.estimateReady ?? null };
  } catch {
    return null;
  }
}

/**
 * Resolves a plain-English interest ("Artificial Intelligence") to the
 * {id, name} pair Meta's targeting requires. Returns null when nothing matches
 * — the caller then simply drops that interest rather than sending an id Meta
 * would reject.
 */
export async function searchMetaInterest(
  group: ZernioKeyGroup,
  accountId: string,
  query: string
): Promise<{ id: string; name: string } | null> {
  try {
    const qs = new URLSearchParams({ q: query, accountId });
    type Row = { id?: string; name?: string; path?: string[] };
    const r = await zernioFetch<{ interests?: Row[]; data?: Row[] }>(group, `/ads/interests?${qs}`);
    const rows = (r.interests ?? r.data ?? []).filter((i) => i?.id && i?.name);
    // Not simply the first result: Meta's top hit is frequently an unrelated
    // entertainment interest, so every candidate is scored (see pickInterest).
    const best = pickInterest(
      query,
      rows.map((i) => ({ id: String(i.id), name: String(i.name), path: Array.isArray(i.path) ? i.path : undefined }))
    );
    return best ? { id: best.id, name: best.name } : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a place name to the opaque key Meta's geo targeting needs. Cities
 * and regions cannot be targeted by name — only by key — so this is what makes
 * the Ads form's "Cities" / "States" answers mean anything. Returns null when
 * the place can't be resolved (the caller then falls back to country targeting
 * rather than sending an id Meta would reject).
 *
 * `geoType` narrows the search ("city", "region", "country", …); the results
 * carry a breadcrumb `path`, which is used to prefer the result in the country
 * the brief actually targets when several places share a name.
 */
export async function searchMetaGeo(
  group: ZernioKeyGroup,
  accountId: string,
  query: string,
  opts: { geoType?: string; countryCode?: string } = {}
): Promise<{ key: string; name: string; type: string; path?: string[] } | null> {
  try {
    const qs = new URLSearchParams({ q: query, accountId, dimension: "geo" });
    if (opts.geoType) qs.set("geoType", opts.geoType);
    if (opts.countryCode) qs.set("countryCode", opts.countryCode);
    const r = await zernioFetch<{
      results?: { id?: string; name?: string; type?: string; path?: string[] }[];
    }>(group, `/ads/targeting/search?${qs}`);
    const results = (r.results ?? []).filter((x) => x?.id && x?.name);
    if (results.length === 0) return null;
    const toHit = (x: { id?: string; name?: string; type?: string; path?: string[] }) => ({
      key: String(x.id),
      name: String(x.name),
      type: String(x.type ?? opts.geoType ?? "city"),
      path: x.path,
    });
    // Same-named places exist in many provinces/countries ("Islamabad" resolves
    // in four Pakistani provinces). Prefer one whose own type is what we asked
    // for and whose breadcrumb ends in the targeted country.
    const exact = results.find((x) => x.type === (opts.geoType ?? "city"));
    return toHit(exact ?? results[0]);
  } catch {
    return null;
  }
}

/** Low-level /ads/campaigns create — kept for callers that only need the campaign shell. */
export function createAdCampaign(
  group: ZernioKeyGroup,
  params: { accountId: string; adAccountId: string; name: string; goal: string; budgetAmount?: number }
): Promise<{ campaign?: { _id?: string; platformCampaignId?: string }; [key: string]: unknown }> {
  return zernioFetch(group, "/ads/campaigns", {
    method: "POST",
    body: JSON.stringify({
      accountId: params.accountId,
      adAccountId: params.adAccountId,
      name: params.name,
      goal: params.goal,
      ...(params.budgetAmount ? { budgetAmount: params.budgetAmount, budgetType: "daily" } : {}),
    }),
  });
}

/** X-Zernio-Signature: lowercase hex HMAC-SHA256 of the raw body, keyed by the webhook's own secret. */
export function verifyZernioSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

export interface ProviderCampaignStatus {
  found: boolean;
  status?: string;
  effectiveStatus?: string;
}

/** READ-ONLY: asks the provider what a campaign's real state is. Never mutates or spends. */
export async function getAdCampaignStatus(group: ZernioKeyGroup, campaignId: string, accountId: string): Promise<ProviderCampaignStatus> {
  try {
    const r = await zernioFetch<{ campaign?: { status?: string; effective_status?: string } }>(
      group,
      `/ads/campaigns/${encodeURIComponent(campaignId)}?accountId=${encodeURIComponent(accountId)}`
    );
    if (!r?.campaign) return { found: false };
    return { found: true, status: r.campaign.status, effectiveStatus: r.campaign.effective_status };
  } catch (e) {
    // 404, or Meta's 400 "Object ... does not exist, cannot be loaded due to missing
    // permissions": either way the provider does NOT confirm the campaign, so it must
    // not be reported as launched. Other errors (5xx, auth, network) stay transient.
    if (/ failed: 404|does not exist|not found|ad_not_found/i.test((e as Error).message)) return { found: false };
    throw e; // transient/auth errors must not be read as "campaign does not exist"
  }
}

export interface CampaignAnalyticsSummary {
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  conversions: number | null;
  costPerConversion: number | null;
  reach: number | null;
}

/**
 * READ-ONLY campaign performance. This is what makes the finance gate on the
 * SECOND and later ads meaningful: decide_ad_finance blocks a new ad when the
 * previous one's ad_performance.is_good is false, and before this existed
 * nothing ever wrote an ad_performance row — so every ad after the first sat
 * on pending_human forever. Never launches, pauses or changes a budget.
 */
export async function getAdCampaignAnalytics(
  group: ZernioKeyGroup,
  campaignId: string,
  opts: { platform?: string; days?: number } = {}
): Promise<CampaignAnalyticsSummary | null> {
  const to = new Date();
  const from = new Date(to.getTime() - (opts.days ?? 30) * 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  });
  if (opts.platform) qs.set("platform", opts.platform);

  try {
    const r = await zernioFetch<{
      analytics?: {
        summary?: {
          spend?: number;
          impressions?: number;
          clicks?: number;
          ctr?: number;
          conversions?: number;
          costPerConversion?: number;
          reach?: number;
        };
      };
    }>(group, `/ads/campaigns/${encodeURIComponent(campaignId)}/analytics?${qs}`);
    const s = r?.analytics?.summary;
    if (!s) return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      spend: num(s.spend),
      impressions: num(s.impressions),
      clicks: num(s.clicks),
      ctr: num(s.ctr),
      conversions: num(s.conversions),
      costPerConversion: num(s.costPerConversion),
      reach: num(s.reach),
    };
  } catch {
    // Analytics can be unavailable (backfill pending, plan limits). Callers must
    // treat null as "no data yet", never as "performed badly".
    return null;
  }
}

/**
 * Billing state of a Meta ad account. `adAccountId` must carry the "act_"
 * prefix (verified live: the bare numeric id is rejected). `ok:null` means the
 * check itself failed (network/Zernio) — callers must not treat that as "no
 * payment method", only as "could not verify".
 */
export async function getAdAccountFinance(
  group: ZernioKeyGroup,
  accountId: string,
  adAccountId: string
): Promise<{ ok: boolean | null; currency: string | null }> {
  try {
    const r = await zernioFetch<{ fundingSource?: unknown; currency?: string }>(
      group,
      `/ads/accounts/finance?accountId=${encodeURIComponent(accountId)}&adAccountId=${encodeURIComponent(adAccountId)}`
    );
    return { ok: Boolean(r?.fundingSource), currency: typeof r?.currency === "string" ? r.currency : null };
  } catch {
    return { ok: null, currency: null };
  }
}

export interface ZernioAccountInfo {
  id: string;
  platform: string;
  /** Meta ad account id (no "act_" prefix) when Zernio reports one, else null. */
  adAccountId: string | null;
}

/**
 * The accounts Zernio itself currently holds for one key group. Returns null
 * when Zernio can't be reached, so callers can tell "no such account" apart
 * from "couldn't check" and never mark a connection dead because of a blip.
 */
export async function listZernioAccounts(group: ZernioKeyGroup): Promise<ZernioAccountInfo[] | null> {
  try {
    const r = await zernioFetch<{ accounts?: Record<string, unknown>[] }>(group, "/accounts");
    return (r.accounts ?? []).map((a) => {
      const md = a.metadata as { subscribedAdAccountIds?: string[]; enumeratedAdAccountIds?: string[] } | undefined;
      const raw = md?.subscribedAdAccountIds?.[0] ?? md?.enumeratedAdAccountIds?.[0];
      return {
        id: String(a._id),
        platform: String(a.platform ?? ""),
        adAccountId: raw ? String(raw).replace(/^act_/, "") : null,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Reads a just-created draft back FROM Meta (via Zernio): the ad set exactly as
 * Meta stored it (raw Graph fields) and the media attached to the ad. This is
 * what lets the app prove the audience and creative Meta holds are the ones the
 * user asked for, instead of trusting that our create request was honoured.
 * Either half is null when it can't be read; callers treat that as "unverified".
 */
export async function readBackDraft(
  group: ZernioKeyGroup,
  p: { accountId: string; adSetId: string; zernioAdId?: string }
): Promise<{ adSet: Record<string, unknown> | null; media: { type: string; url?: string }[] | null }> {
  const fields = "targeting,daily_budget,status,effective_status,start_time,end_time,optimization_goal";
  const [adSet, media] = await Promise.all([
    zernioFetch<{ adSet?: Record<string, unknown> }>(
      group,
      `/ads/ad-sets/${encodeURIComponent(p.adSetId)}?accountId=${encodeURIComponent(p.accountId)}&fields=${encodeURIComponent(fields)}`
    )
      .then((r) => r.adSet ?? null)
      .catch(() => null),
    p.zernioAdId
      ? zernioFetch<{ media?: { type?: string; url?: string }[] }>(group, `/ads/${encodeURIComponent(p.zernioAdId)}/media`)
          .then((r) => (r.media ?? []).map((m) => ({ type: String(m.type ?? ""), url: m.url })))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return { adSet, media };
}

/**
 * Zernio keeps its own "Ad" record for every ad and ties it to the Zernio
 * ACCOUNT id it was created under. Every Facebook reconnect gives the account
 * a NEW id, which orphans those records: the campaign still exists on Meta
 * (reads by accountId still work) but PUT /ads/campaigns/{id}/status answers
 * 404 "Campaign not found". Looking the ad up by its Meta numeric id makes
 * Zernio re-import it under the current account, after which status/delete
 * calls work again. Errors are swallowed on purpose - this is a best-effort
 * repair, and the real call that follows reports any genuine failure.
 */
export async function ensureZernioAdRecord(group: ZernioKeyGroup, metaAdId: string | null | undefined): Promise<void> {
  if (!metaAdId) return;
  try {
    await zernioFetch(group, `/ads/${encodeURIComponent(metaAdId)}`);
  } catch {
    // see above
  }
}

/** Pause/resume a campaign, repairing Zernio's ad record first and retrying once on a 404. */
export async function setCampaignStatusResilient(
  group: ZernioKeyGroup,
  p: { campaignId: string; metaAdId?: string | null; status: "active" | "paused"; platform: string }
): Promise<Record<string, unknown>> {
  await ensureZernioAdRecord(group, p.metaAdId);
  try {
    return await setAdCampaignStatus(group, p.campaignId, p.status, p.platform);
  } catch (err) {
    if (!/failed: 404|not found/i.test((err as Error).message) || !p.metaAdId) throw err;
    await ensureZernioAdRecord(group, p.metaAdId);
    return setAdCampaignStatus(group, p.campaignId, p.status, p.platform);
  }
}
