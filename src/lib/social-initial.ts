import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientBusinessContext, describeContextForLog } from "@/lib/business-context";
import { isBusinessProfileComplete } from "@/lib/business-profile";
import { generateAdVideo, generateSocialImage } from "@/lib/gemini";
import {
  createStrategicItem,
  historyRow,
  loadContentHistory,
  publishToConnections,
  type ConnectionRef,
  type StrategicItem,
} from "@/lib/social-content";
import { logEvent } from "@/lib/log-event";

/**
 * First-connection validation cycle.
 *
 * When a business connects Facebook/Instagram for the first time, about five
 * minutes later we generate and publish an image post + its story and a video
 * post + its story — all from the business's OWN context, through the same
 * planning and Zernio publishing path the recurring scheduler uses — to prove
 * end to end that context, image/video generation, captions, hashtags, CTAs,
 * stories and publishing all work.
 *
 * Safety properties:
 *  - one cycle per business, ever: social_initial_runs.client_id is the primary
 *    key and scheduling is insert-or-ignore, so reconnecting never re-triggers
 *  - each of the four items reserves a social_posts row with a fixed dedupe_key
 *    (unique per client) BEFORE anything is published, and `steps` records
 *    completion, so a retried or overlapping job resumes and never re-publishes
 *  - it will not run on a thin profile (generic content is exactly what this is
 *    meant to rule out); it waits for the profile instead
 */

const DELAY_MINUTES = 5;
const RETRY_MINUTES = 10;
const MAX_ATTEMPTS = 4;
const LEASE_MINUTES = 25; // video generation alone can take ~8 minutes
const PROFILE_WAIT_DAYS = 3;

type StepKey = "image_post" | "image_story" | "video_post" | "video_story";
type Steps = Partial<Record<StepKey, { row_id: string; note?: string }>>;

interface RunRow {
  client_id: string;
  run_after: string;
  status: string;
  attempts: number;
  steps: Steps;
  cycle: number;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Called from the Zernio connect callback — every successful Facebook/Instagram connection, including a
 * reconnect after a disconnect, queues a validation cycle ~5 minutes out. The only case it does NOT stack a
 * new one is when a cycle is already queued/running for this business (a double callback must not post twice).
 * Returns true when a cycle was queued.
 */
export async function scheduleInitialRun(admin: SupabaseClient, clientId: string, accountId?: string): Promise<boolean> {
  const { data: existing } = await admin.from("social_initial_runs").select("status").eq("client_id", clientId).maybeSingle();
  if (!existing) {
    const runAfter = new Date(Date.now() + DELAY_MINUTES * 60_000).toISOString();
    const { error } = await admin.from("social_initial_runs").insert({ client_id: clientId, run_after: runAfter, status: "queued", account_id: accountId ?? null });
    if (error && error.code !== "23505") console.error(`[social_initial_runs] could not schedule: ${error.message}`);
    return !error;
  }
  if (["queued", "running", "waiting_profile"].includes(existing.status)) return false; // one already on its way
  return resetInitialRun(admin, clientId, accountId);
}

/**
 * A connected business must have comment/DM handling and content automation switched on without a separate
 * trip to the wizard. Creates the platform's settings row with sensible defaults ONLY when there is none and
 * the business profile is complete; an existing row (the owner's own choices, or a paused automation) is
 * never touched. New rows draft recurring posts for review (draft_only) — the owner opts in to auto-publish.
 */
export async function ensureAutomationDefaults(admin: SupabaseClient, clientId: string, platform: string): Promise<boolean> {
  const { data: existing } = await admin.from("social_automation_settings").select("id").eq("client_id", clientId).eq("platform", platform).maybeSingle();
  if (existing) return false;
  const [{ data: client }, { data: profile }] = await Promise.all([
    admin.from("clients").select("id, company_name").eq("id", clientId).maybeSingle(),
    admin.from("client_social_profile").select("*").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!isBusinessProfileComplete(client, profile)) return false;
  const { error } = await admin.from("social_automation_settings").insert({
    client_id: clientId,
    platform,
    automation_active: true,
    activated_at: new Date().toISOString(),
    dm_enabled: true,
    comment_enabled: true,
    human_handoff_enabled: true,
    auto_create_enabled: true,
    stories_enabled: true,
    auto_publish_enabled: false,
    approval_mode: "draft_only",
    publish_mode: "approval_required",
  });
  return !error;
}

/** Starts a fresh cycle (new dedupe keys, empty steps) — for a new account, or forced from the QA route. */
export async function resetInitialRun(admin: SupabaseClient, clientId: string, accountId?: string, delayMinutes = DELAY_MINUTES): Promise<boolean> {
  const { data: existing } = await admin.from("social_initial_runs").select("cycle").eq("client_id", clientId).maybeSingle();
  if (!existing) return false;
  const { error } = await admin
    .from("social_initial_runs")
    .update({
      cycle: (existing.cycle ?? 1) + 1,
      status: "queued",
      steps: {},
      attempts: 0,
      last_error: null,
      lease_until: null,
      run_after: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
      ...(accountId ? { account_id: accountId } : {}),
    })
    .eq("client_id", clientId);
  return !error;
}

/** Runs due for processing (never-started, waiting on the profile, retrying, or with an expired lease). */
export async function dueInitialRuns(admin: SupabaseClient, onlyClientId?: string, ignoreDelay = false): Promise<RunRow[]> {
  const nowIso = new Date().toISOString();
  let q = admin.from("social_initial_runs").select("*").in("status", ["queued", "waiting_profile", "running"]);
  if (!ignoreDelay) q = q.lte("run_after", nowIso);
  if (onlyClientId) q = q.eq("client_id", onlyClientId);
  const { data } = await q.returns<(RunRow & { lease_until: string | null })[]>();
  return (data ?? []).filter((r) => r.status !== "running" || !r.lease_until || r.lease_until < nowIso);
}

/** Optimistic claim: only the worker whose updated_at matches wins, so two cron ticks never run one cycle twice. */
async function claim(admin: SupabaseClient, run: RunRow): Promise<boolean> {
  const { data } = await admin
    .from("social_initial_runs")
    .update({
      status: "running",
      lease_until: new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString(),
      attempts: run.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", run.client_id)
    .eq("updated_at", run.updated_at)
    .select("client_id");
  return (data ?? []).length > 0;
}

async function saveSteps(admin: SupabaseClient, clientId: string, steps: Steps) {
  await admin.from("social_initial_runs").update({ steps, updated_at: new Date().toISOString() }).eq("client_id", clientId);
}

export interface InitialRunResult {
  client_id: string;
  status: "completed" | "waiting_profile" | "retry" | "failed" | "skipped";
  steps: string[];
  detail?: string;
}

export async function processInitialRun(admin: SupabaseClient, run: RunRow): Promise<InitialRunResult> {
  const clientId = run.client_id;
  if (!(await claim(admin, run))) return { client_id: clientId, status: "skipped", steps: [], detail: "claimed by another worker" };

  const steps: Steps = { ...(run.steps ?? {}) };
  // Cycle 1 keeps the original keys; later cycles get their own so a new cycle never collides with an old one.
  const dedupeKey = (key: StepKey) => ((run.cycle ?? 1) > 1 ? `initial_c${run.cycle}_${key}` : `initial_${key}`);
  const fail = async (status: "failed" | "queued" | "waiting_profile", detail: string, after = RETRY_MINUTES) => {
    await admin
      .from("social_initial_runs")
      .update({
        status,
        last_error: detail,
        lease_until: null,
        run_after: new Date(Date.now() + after * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("client_id", clientId);
  };

  try {
    const [{ data: client }, { data: profile }, { data: conns }] = await Promise.all([
      admin.from("clients").select("id, company_name").eq("id", clientId).maybeSingle(),
      admin.from("client_social_profile").select("*").eq("client_id", clientId).maybeSingle(),
      admin
        .from("social_connections")
        .select("platform, zernio_account_id")
        .eq("client_id", clientId)
        .eq("connection_status", "connected")
        .in("platform", ["instagram", "facebook"])
        .returns<ConnectionRef[]>(),
    ]);

    const connections = (conns ?? []).filter((c) => c.zernio_account_id);
    if (!connections.length) {
      await fail("failed", "No connected Facebook/Instagram account");
      return { client_id: clientId, status: "failed", steps: Object.keys(steps), detail: "no connected account" };
    }

    if (!isBusinessProfileComplete(client, profile)) {
      const tooLong = Date.now() - new Date(run.created_at).getTime() > PROFILE_WAIT_DAYS * 86_400_000;
      await fail(tooLong ? "failed" : "waiting_profile", "Business profile incomplete — generic content is not published", 30);
      return { client_id: clientId, status: tooLong ? "failed" : "waiting_profile", steps: [], detail: "business profile incomplete" };
    }

    const ctx = await getClientBusinessContext(admin, clientId);
    console.log(`[context] initial-cycle ${describeContextForLog(ctx)}`);

    // Reserve-then-publish for one item. Returns the row id and, when we just
    // published, the media so the story step can reuse it.
    const runItem = async (
      key: StepKey,
      item: StrategicItem,
      contentType: "image" | "video" | "story",
      media: { base64: string; mimeType: string; kind: "image" | "video" },
      story: boolean
    ) => {
      const { data: row, error } = await admin
        .from("social_posts")
        .insert(
          historyRow(clientId, item, {
            platform: connections.map((c) => c.platform).join(","),
            content_type: contentType,
            status: "creating",
            dedupe_key: dedupeKey(key),
          })
        )
        .select("id")
        .single<{ id: string }>();
      if (error || !row) {
        if (error?.code === "23505") {
          // A previous attempt reserved this item and may have published it: never publish it again.
          const { data: prior } = await admin.from("social_posts").select("id").eq("client_id", clientId).eq("dedupe_key", dedupeKey(key)).maybeSingle();
          steps[key] = { row_id: prior?.id ?? "", note: "already reserved by an earlier attempt — not re-published" };
          await saveSteps(admin, clientId, steps);
          return null;
        }
        throw new Error(`Could not reserve ${key}: ${error?.message}`);
      }
      const published = await publishToConnections({
        conns: connections,
        mayPublish: () => true, // validation cycle: the point is to publish for real
        media,
        caption: item.caption,
        story,
        filenameBase: `initial-${key}`,
      });
      await admin
        .from("social_posts")
        .update({
          media_url: published.mediaUrl,
          zernio_post_id: published.zernioPostIds[0] ?? null,
          status: "published",
          published_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      steps[key] = { row_id: row.id };
      await saveSteps(admin, clientId, steps);
      logEvent("social_initial.step", { client_id: clientId, step: key, pillar: item.plan.pillar, objective: item.plan.objective });
      return { rowId: row.id, mediaUrl: published.mediaUrl, zernioId: published.zernioPostIds[0] };
    };

    const feedRow = async (id: string) => {
      const { data } = await admin
        .from("social_posts")
        .select("id, topic, hook, caption, cta, content_pillar, product_name, media_url")
        .eq("id", id)
        .maybeSingle();
      return data;
    };
    const attachStory = async (feedId: string, storyResult: { mediaUrl: string; zernioId?: string } | null) => {
      if (storyResult) {
        await admin.from("social_posts").update({ story_media_url: storyResult.mediaUrl, story_zernio_post_id: storyResult.zernioId ?? null }).eq("id", feedId);
      }
    };

    // ---- 1. image post (opens with education) ----
    let imageItem: StrategicItem | undefined;
    if (!steps.image_post) {
      const history = await loadContentHistory(admin, clientId);
      imageItem = await createStrategicItem({ ctx, history, format: "image", forcePillar: "educational" });
      const img = await generateSocialImage(imageItem.draft.imagePrompt || imageItem.draft.storyImagePrompt || imageItem.draft.topic, "1:1");
      await runItem("image_post", imageItem, "image", { ...img, kind: "image" }, false);
    }

    // ---- 2. image story: a teaser of the image post ----
    if (!steps.image_story && steps.image_post?.row_id) {
      const feed = await feedRow(steps.image_post.row_id);
      if (feed?.topic && feed.caption) {
        const history = await loadContentHistory(admin, clientId);
        const item = await createStrategicItem({
          ctx,
          history,
          format: "story",
          supports: { ...feed, topic: feed.topic, hook: feed.hook ?? feed.topic, caption: feed.caption },
        });
        const img = await generateSocialImage(item.draft.storyImagePrompt || item.draft.imagePrompt || item.draft.topic, "9:16");
        const res = await runItem("image_story", item, "story", { ...img, kind: "image" }, true);
        await attachStory(feed.id, res);
      }
    }

    // ---- 3. video post ----
    await admin.from("social_initial_runs").update({ lease_until: new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString() }).eq("client_id", clientId);
    let video: { base64: string; mimeType: string } | undefined;
    if (!steps.video_post) {
      const history = await loadContentHistory(admin, clientId);
      const item = await createStrategicItem({ ctx, history, format: "video" });
      // Spoken narration: the hook is read aloud in the clip (Veo falls back to a silent render if its audio filter objects).
      const spoken = `${item.draft.videoPrompt || item.draft.topic}

A narrator says aloud: "${item.draft.hook}"`;
      video = await generateAdVideo({ prompt: spoken, aspectRatio: "9:16", durationSeconds: 8, spokenAudio: true });
      await runItem("video_post", item, "video", { ...video, kind: "video" }, false);
    }

    // ---- 4. video story: the video adapted as a story ----
    if (!steps.video_story && steps.video_post?.row_id) {
      const feed = await feedRow(steps.video_post.row_id);
      if (feed?.topic && feed.caption) {
        if (!video && feed.media_url) {
          // Resumed run: the clip was generated earlier, so fetch the hosted copy instead of paying for another render.
          const dl = await fetch(feed.media_url);
          if (dl.ok) video = { base64: Buffer.from(await dl.arrayBuffer()).toString("base64"), mimeType: dl.headers.get("content-type") ?? "video/mp4" };
        }
        if (video) {
          const history = await loadContentHistory(admin, clientId);
          const item = await createStrategicItem({
            ctx,
            history,
            format: "story",
            supports: { ...feed, topic: feed.topic, hook: feed.hook ?? feed.topic, caption: feed.caption },
          });
          const res = await runItem("video_story", item, "story", { ...video, kind: "video" }, true);
          await attachStory(feed.id, res);
        }
      }
    }

    const done = (["image_post", "image_story", "video_post", "video_story"] as StepKey[]).every((k) => steps[k]);
    await admin
      .from("social_initial_runs")
      .update({ status: done ? "completed" : run.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "queued", lease_until: null, last_error: done ? null : "some steps still pending", updated_at: new Date().toISOString(), run_after: new Date(Date.now() + RETRY_MINUTES * 60_000).toISOString() })
      .eq("client_id", clientId);
    logEvent("social_initial.finished", { client_id: clientId, completed: done, steps: Object.keys(steps).join(",") });
    return { client_id: clientId, status: done ? "completed" : "retry", steps: Object.keys(steps) };
  } catch (err) {
    const message = (err as Error).message;
    await saveSteps(admin, clientId, steps);
    const exhausted = run.attempts + 1 >= MAX_ATTEMPTS;
    await fail(exhausted ? "failed" : "queued", message.slice(0, 500));
    logEvent("social_initial.failed", { client_id: clientId, error: message, exhausted });
    return { client_id: clientId, status: exhausted ? "failed" : "retry", steps: Object.keys(steps), detail: message };
  }
}

/**
 * Runs the cycle for one business from inside the connect request's lifetime
 * (Next.js `after`), so it works wherever the app is running — including local
 * dev and any host without cron. Waits out the ~5 minute delay when the run was
 * just scheduled; a stale queued run (e.g. from an earlier connection) starts
 * immediately. The cron route stays as the fallback/resume path, and claim()
 * guarantees the two can never run the same cycle twice.
 */
export async function runInitialCycleAfterDelay(admin: SupabaseClient, clientId: string, waitMinutes: number): Promise<void> {
  if (waitMinutes > 0) await new Promise((r) => setTimeout(r, waitMinutes * 60_000 + 5_000));
  for (const run of await dueInitialRuns(admin, clientId)) {
    const result = await processInitialRun(admin, run);
    logEvent("social_initial.after", { client_id: clientId, status: result.status });
  }
}

export const INITIAL_DELAY_MINUTES = DELAY_MINUTES;
