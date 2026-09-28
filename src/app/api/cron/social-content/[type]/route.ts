import { getClientBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronRequest } from "@/lib/webhook-security";
import { generateAdVideo, generateSocialImage } from "@/lib/gemini";
import { createStrategicItem, historyRow, loadContentHistory, publishToConnections, type StrategicItem } from "@/lib/social-content";
import { dueItems, isValidTimeZone, localClock, slotKey, type ScheduleInput } from "@/lib/social-schedule";
import { logEvent } from "@/lib/log-event";

/**
 * Settings-driven social content scheduler.
 *
 * Runs every 30 minutes for each kind (feed post / story). For every client
 * whose automation is active it works out — from the wizard settings (feed posts
 * per week, how many are videos, stories per week, optional preferred time) —
 * what is due TODAY in the client's timezone (see social-schedule.ts), and
 * generates and publishes exactly the items whose time has arrived and that
 * have not been generated yet. Each item is planned from the business context
 * and recent history (content-strategy.ts): pillar, objective, product, CTA.
 *
 * Auth: Vercel Cron (Authorization: Bearer $CRON_SECRET).
 * QA overrides: ?client_id=<id> limits to one client; ?at=YYYY-MM-DDTHH:mm sets
 * the local clock (e.g. ?at=2026-09-28T17:05 to run Monday's 17:00 slot).
 * ?dry=1 lists the slots that would be generated without doing anything.
 * Video generation is slow, hence the long maxDuration.
 */
export const maxDuration = 300; // Hobby-plan ceiling. A Veo video can take longer, so video needs the Pro plan (raise this to 800 there).

const SUPPORTED = ["instagram", "facebook"];

interface AutomationRow {
  client_id: string;
  platform: string;
  auto_create_enabled: boolean | null;
  auto_publish_enabled: boolean | null;
  stories_enabled: boolean | null;
  approval_mode: string | null;
  publish_mode: string | null;
  image_posts_per_week: number | null;
  carousel_posts_per_week: number | null;
  video_posts_per_week: number | null;
  posts_per_week: number | null;
  stories_per_week: number | null;
  post_time: string | null;
  timezone: string | null;
}

/**
 * Does this platform's configuration actually permit us to PUBLISH, or may we
 * only prepare a draft?
 *
 * The wizard's own words: approval_mode "draft_only" = "AI creates, you publish
 * manually", and publish_mode "approval_required" = "you approve before
 * publishing". Both mean the same thing operationally — nothing may go live on
 * its own. auto_publish_enabled is the explicit switch for it.
 */
function mayAutoPublish(row: AutomationRow): boolean {
  if (row.auto_publish_enabled === false) return false;
  if (row.approval_mode === "draft_only") return false;
  if (row.publish_mode === "approval_required") return false;
  return true;
}

interface ConnectionRow {
  client_id: string;
  platform: string;
  zernio_account_id: string | null;
}

const max = (rows: AutomationRow[], pick: (r: AutomationRow) => number | null) => Math.max(0, ...rows.map((r) => pick(r) ?? 0));

export async function GET(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (type !== "post" && type !== "story") {
    return NextResponse.json({ error: "type must be 'post' or 'story'" }, { status: 400 });
  }
  if (!isCronRequest(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const defaultTz = process.env.CONTENT_TIMEZONE || "Asia/Karachi";
  const at = req.nextUrl.searchParams.get("at");
  // ?dry=1 reports which slots WOULD be generated (no generation, no publishing, no writes) — for checking a schedule.
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const { data: automations, error: autoErr } = await admin
    .from("social_automation_settings")
    .select(
      "client_id, platform, auto_create_enabled, auto_publish_enabled, stories_enabled, approval_mode, publish_mode, image_posts_per_week, carousel_posts_per_week, video_posts_per_week, posts_per_week, stories_per_week, post_time, timezone"
    )
    .eq("automation_active", true)
    .in("platform", SUPPORTED)
    .returns<AutomationRow[]>();
  if (autoErr) return NextResponse.json({ error: autoErr.message }, { status: 500 });

  const rowsByClient = new Map<string, AutomationRow[]>();
  for (const a of automations ?? []) rowsByClient.set(a.client_id, [...(rowsByClient.get(a.client_id) ?? []), a]);

  const clientFilter = req.nextUrl.searchParams.get("client_id");
  const clientIds = [...rowsByClient.keys()].filter((id) => !clientFilter || id === clientFilter);
  if (!clientIds.length) return NextResponse.json({ ok: true, generated: 0, reason: "no active automation" });

  const [{ data: clients }, { data: connections }] = await Promise.all([
    admin.from("clients").select("id, company_name").in("id", clientIds),
    admin
      .from("social_connections")
      .select("client_id, platform, zernio_account_id")
      .eq("connection_status", "connected")
      .in("platform", SUPPORTED)
      .in("client_id", clientIds)
      .returns<ConnectionRow[]>(),
  ]);
  const clientIdsKnown = new Set((clients ?? []).map((c) => c.id));
  const connsByClient = new Map<string, ConnectionRow[]>();
  for (const c of connections ?? []) {
    if (!c.zernio_account_id) continue;
    connsByClient.set(c.client_id, [...(connsByClient.get(c.client_id) ?? []), c]);
  }

  const results: { client_id: string; slot: string; result: "published" | "drafted" | "skipped" | "error"; detail?: string }[] = [];

  for (const clientId of clientIds) {
    const rows = rowsByClient.get(clientId) ?? [];
    const conns = connsByClient.get(clientId) ?? [];
    if (!clientIdsKnown.has(clientId) || (!conns.length && !dry)) continue;

    // The wizard's own switches: "Automatic Post Creation" gates feed posts, "Stories" gates stories.
    const enabled = type === "post" ? rows.some((r) => r.auto_create_enabled) : rows.some((r) => r.stories_enabled);
    if (!enabled) {
      results.push({ client_id: clientId, slot: type, result: "skipped", detail: type === "post" ? "automatic post creation is off" : "stories are off" });
      continue;
    }

    const input: ScheduleInput = {
      images: max(rows, (r) => r.image_posts_per_week),
      carousels: max(rows, (r) => r.carousel_posts_per_week),
      videos: max(rows, (r) => r.video_posts_per_week),
      stories: max(rows, (r) => r.stories_per_week),
      postsPerWeek: max(rows, (r) => r.posts_per_week),
      postTime: rows.map((r) => r.post_time).find(Boolean) ?? null,
    };
    const tzPref = rows.map((r) => r.timezone).find(isValidTimeZone);
    const clock = localClock(tzPref ?? defaultTz, new Date(), at);

    for (const item of dueItems(input, clock, type)) {
      const key = slotKey(type, clock.date, item.slot);
      const { data: existing } = await admin.from("social_posts").select("id").eq("client_id", clientId).eq("dedupe_key", key).limit(1);
      if (existing && existing.length) continue; // already generated for this slot
      if (dry) {
        results.push({ client_id: clientId, slot: key, result: "skipped", detail: `WOULD GENERATE ${item.format} at ${String(Math.floor(item.minutes / 60)).padStart(2, "0")}:${String(item.minutes % 60).padStart(2, "0")} local` });
        continue;
      }

      // Reserve the slot BEFORE the slow generation (unique on client_id + dedupe_key), so an overlapping
      // run or a retry cannot generate/publish the same slot twice.
      const contentType = type === "story" ? "story" : item.format === "video" ? "video" : "image";
      const { data: reserved, error: reserveErr } = await admin
        .from("social_posts")
        .insert({ client_id: clientId, platform: conns.map((c) => c.platform).join(","), content_type: contentType, status: "creating", dedupe_key: key })
        .select("id")
        .single<{ id: string }>();
      if (reserveErr || !reserved) {
        results.push({ client_id: clientId, slot: key, result: "skipped", detail: reserveErr?.code === "23505" ? "slot already taken" : reserveErr?.message });
        continue;
      }

      let anyCreated = false;
      try {
        const ctx = await getClientBusinessContext(admin, clientId);
        const history = await loadContentHistory(admin, clientId);

        // A story supports the most recent feed post that has no story yet.
        let supports: Parameters<typeof createStrategicItem>[0]["supports"];
        let supported: { id: string; content_type: string | null; media_url: string | null } | null = null;
        if (type === "story") {
          const since = new Date(Date.now() - 36 * 3600_000).toISOString();
          const { data: feed } = await admin
            .from("social_posts")
            .select("id, topic, hook, caption, cta, content_pillar, product_name, content_type, media_url")
            .eq("client_id", clientId)
            .in("content_type", ["image", "video"])
            .neq("status", "failed")
            .is("story_media_url", null)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (feed?.topic && feed.caption) {
            supports = { ...feed, topic: feed.topic, hook: feed.hook ?? feed.topic, caption: feed.caption };
            supported = { id: feed.id, content_type: feed.content_type, media_url: feed.media_url };
          }
        }

        const format = type === "story" ? "story" : item.format === "video" ? "video" : "image";
        const strategic: StrategicItem = await createStrategicItem({ ctx, history, format, supports });

        // Media: feed video → Veo clip with the hook read aloud; story of a video post → that clip; otherwise an image.
        let media: { base64: string; mimeType: string; kind: "image" | "video" };
        if (format === "video") {
          const spoken = `${strategic.draft.videoPrompt || strategic.draft.topic}\n\nA narrator says aloud: "${strategic.draft.hook}"`;
          media = { ...(await generateAdVideo({ prompt: spoken, aspectRatio: "9:16", durationSeconds: 8, spokenAudio: true })), kind: "video" };
        } else if (format === "story" && supported?.content_type === "video" && supported.media_url) {
          const dl = await fetch(supported.media_url);
          if (!dl.ok) throw new Error(`Could not fetch the video to reuse as a story: ${dl.status}`);
          media = { base64: Buffer.from(await dl.arrayBuffer()).toString("base64"), mimeType: dl.headers.get("content-type") ?? "video/mp4", kind: "video" };
        } else {
          const prompt = format === "story" ? strategic.draft.storyImagePrompt : strategic.draft.imagePrompt || strategic.draft.storyImagePrompt || strategic.draft.topic;
          media = { ...(await generateSocialImage((prompt || strategic.draft.topic).slice(0, 1200), format === "story" ? "9:16" : "1:1")), kind: "image" };
        }

        const published = await publishToConnections({
          conns,
          // No settings row for a platform is NOT permission to publish — fail safe to draft.
          mayPublish: (platform) => {
            const row = rows.find((r) => r.platform === platform);
            return row ? mayAutoPublish(row) : false;
          },
          media,
          caption: strategic.caption,
          story: type === "story",
          filenameBase: key,
        });
        anyCreated = true;

        await admin
          .from("social_posts")
          .update({
            ...historyRow(clientId, strategic, {}),
            media_url: published.mediaUrl,
            zernio_post_id: published.zernioPostIds[0] ?? null,
            status: published.anyPublish ? "published" : "draft",
            published_at: published.anyPublish ? new Date().toISOString() : null,
          })
          .eq("id", reserved.id);
        if (supported) {
          await admin.from("social_posts").update({ story_media_url: published.mediaUrl, story_zernio_post_id: published.zernioPostIds[0] ?? null }).eq("id", supported.id);
        }

        logEvent("social_content.generated", { client_id: clientId, kind: type, slot: key, format, pillar: strategic.plan.pillar, objective: strategic.plan.objective, published: published.anyPublish });
        results.push({ client_id: clientId, slot: key, result: published.anyPublish ? "published" : "drafted" });
      } catch (err) {
        // Nothing reached Zernio: free the slot so the next tick retries it. Something did: keep the row so it is never published twice.
        if (!anyCreated) await admin.from("social_posts").delete().eq("id", reserved.id);
        else await admin.from("social_posts").update({ status: "failed" }).eq("id", reserved.id);
        logEvent("social_content.failed", { client_id: clientId, kind: type, slot: key, error: (err as Error).message });
        results.push({ client_id: clientId, slot: key, result: "error", detail: (err as Error).message });
      }
    }
  }

  return NextResponse.json({ ok: true, type, generated: results.filter((r) => r.result === "published" || r.result === "drafted").length, results });
}
