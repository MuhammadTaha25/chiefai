import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientBusinessContext } from "@/lib/business-context";
import { generateSocialImage } from "@/lib/gemini";
import { uploadZernioMediaDirect, type ZernioKeyGroup } from "@/lib/zernio";
import { loadContentHistory, createStrategicItem } from "@/lib/social-content";

/**
 * "Generate with AI" for the post composer.
 *
 * Uses the same strategy pipeline as the scheduled cron — content pillar
 * rotation, history-aware repeat detection, and a retry loop — so every
 * manual generation picks a DIFFERENT angle from recent posts rather than
 * repeating the same caption style every time.
 *
 * Everything the client filled in — the business profile AND the social
 * wizard's content preferences — is read back here and used as the ground
 * truth for the prompt. Nothing about the business comes from the browser;
 * the caller only chooses a platform and a format.
 *
 * The generated image is uploaded to Zernio immediately and only its URL is
 * returned, so the composer attaches a hosted media URL rather than carrying a
 * multi-megabyte base64 blob through the browser and back.
 */
const KEY_GROUP_BY_PLATFORM: Record<string, ZernioKeyGroup> = {
  instagram: "tiktok_instagram",
  tiktok: "tiktok_instagram",
  facebook: "google_meta",
  linkedin: "google_meta",
  youtube: "google_meta",
};

// Generation costs a Gemini image call per request; keep a light per-client
// guard so a stuck button cannot burn the quota.
const lastRun = new Map<string, number>();
const MIN_INTERVAL_MS = 5_000;

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  const platform = String(body.platform ?? "instagram").toLowerCase();
  const kind = ["image", "carousel", "video", "story"].includes(body.kind) ? (body.kind as "image" | "carousel" | "video" | "story") : "image";
  const withImage = body.with_image !== false;

  const keyGroup = KEY_GROUP_BY_PLATFORM[platform];
  if (!keyGroup) return NextResponse.json({ error: `Unsupported platform "${platform}"` }, { status: 400 });

  const last = lastRun.get(client.id) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "Just a moment — a generation is already running." }, { status: 429 });
  }
  lastRun.set(client.id, Date.now());

  const admin = createAdminClient();
  const ctx = await getClientBusinessContext(admin, client.id);
  if (!ctx.businessName && !ctx.description && !ctx.services) {
    return NextResponse.json(
      { error: "Fill in your Business Profile first — the AI writes from it, and it is empty right now." },
      { status: 400 }
    );
  }

  try {
    // Load recent post history so the strategy pipeline can rotate pillars
    // and avoid repeating recent topics/hooks.
    const history = await loadContentHistory(admin, client.id);

    // Map kind to the format the strategy pipeline expects.
    const format = kind === "story" ? "story" : kind === "video" ? "video" : "image";

    const strategic = await createStrategicItem({ ctx, history, format });

    // Determine which image prompt to use based on format.
    const imagePrompt = format === "story"
      ? strategic.draft.storyImagePrompt
      : strategic.draft.imagePrompt || strategic.draft.storyImagePrompt;

    let mediaUrl: string | null = null;
    if (withImage && imagePrompt) {
      const img = await generateSocialImage(imagePrompt.slice(0, 1200), kind === "story" ? "9:16" : "1:1");
      const uploaded = await uploadZernioMediaDirect(keyGroup, {
        bytes: Buffer.from(img.base64, "base64"),
        filename: `ai-${platform}-${kind}-${Date.now()}.png`,
        contentType: img.mimeType.startsWith("image/") ? img.mimeType : "image/png",
      });
      mediaUrl = uploaded.url ?? uploaded.mediaUrl ?? null;
    }

    // Return in the same shape the composer expects (caption + hashtags + imagePrompt).
    return NextResponse.json({
      ok: true,
      idea: {
        caption: strategic.caption,
        hashtags: strategic.draft.hashtags,
        imagePrompt,
      },
      mediaUrl,
      // Extra context so the UI can optionally show what pillar was chosen.
      pillar: strategic.plan.pillar,
      topic: strategic.draft.topic,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
