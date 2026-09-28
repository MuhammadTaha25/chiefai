import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { generateSocialPostIdea, generateSocialImage } from "@/lib/gemini";
import { uploadZernioMediaDirect, type ZernioKeyGroup } from "@/lib/zernio";

/**
 * "Generate with AI" for the post composer.
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
  const kind = ["image", "carousel", "video", "story"].includes(body.kind) ? body.kind : "image";
  const withImage = body.with_image !== false;
  const instruction = typeof body.instruction === "string" ? body.instruction.slice(0, 500) : undefined;

  const keyGroup = KEY_GROUP_BY_PLATFORM[platform];
  if (!keyGroup) return NextResponse.json({ error: `Unsupported platform "${platform}"` }, { status: 400 });

  const last = lastRun.get(client.id) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "Just a moment — a generation is already running." }, { status: 429 });
  }
  lastRun.set(client.id, Date.now());

  // The wizard's own preferences are part of the grounding, not decoration.
  const { data: settings } = await supabase
    .from("social_automation_settings")
    .select("content_preference, posts_per_week, image_posts_per_week, carousel_posts_per_week, video_posts_per_week, stories_per_week")
    .eq("client_id", client.id)
    .eq("platform", platform)
    .maybeSingle<{ content_preference: string | null; posts_per_week: number | null }>();

  const admin = createAdminClient();
  const ctx = await getClientBusinessContext(admin, client.id);
  if (!ctx.businessName && !ctx.description && !ctx.services) {
    return NextResponse.json(
      { error: "Fill in your Business Profile first — the AI writes from it, and it is empty right now." },
      { status: 400 }
    );
  }

  try {
    const idea = await generateSocialPostIdea({
      companyName: ctx.businessName ?? "the business",
      platform,
      kind,
      businessContext: formatBusinessContext(ctx),
      contentPreference: settings?.content_preference ?? undefined,
      postsPerWeek: settings?.posts_per_week ?? undefined,
      extraInstruction: instruction,
    });

    if (!idea.caption && !idea.imagePrompt) {
      return NextResponse.json({ error: "The AI returned nothing usable — try again." }, { status: 502 });
    }

    let mediaUrl: string | null = null;
    if (withImage && idea.imagePrompt) {
      const img = await generateSocialImage(idea.imagePrompt.slice(0, 1200), kind === "story" ? "9:16" : "1:1");
      const uploaded = await uploadZernioMediaDirect(keyGroup, {
        bytes: Buffer.from(img.base64, "base64"),
        filename: `ai-${platform}-${kind}-${Date.now()}.png`,
        contentType: img.mimeType.startsWith("image/") ? img.mimeType : "image/png",
      });
      mediaUrl = uploaded.url ?? uploaded.mediaUrl ?? null;
    }

    return NextResponse.json({ ok: true, idea, mediaUrl });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
