import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createZernioPost,
  uploadZernioMediaDirect,
  type ZernioKeyGroup,
  type ZernioMediaItem,
  type ZernioPostPlatform,
} from "@/lib/zernio";

/**
 * Post creation / publishing.
 *
 * This previously did not exist at all — the Content page only ever READ
 * `social_posts`, the wizard said "post creation and publishing: not available
 * yet", and nothing in the app ever called Zernio's post API. So "scheduled
 * publishing" was a stored setting with no executor behind it. This is that
 * executor for the manual path.
 *
 * HOW THE POST TYPE IS DECIDED (from Zernio's OpenAPI spec, not guesswork):
 *   - Instagram: `contentType` only accepts "story". Everything else is a feed
 *     post, and a SINGLE VIDEO automatically becomes a Reel. Multiple images
 *     become a carousel.
 *   - Facebook: `contentType` accepts "story" (24h Page story) or "reel";
 *     omitting it gives a normal feed post.
 *   - Instagram has NO text-only post type — it is rejected outright.
 * So the caller picks an intent (feed / story / reel) and the media they attach
 * determines the concrete result; we send contentType only where it is
 * meaningful rather than inventing a flag the provider does not have.
 *
 * Zernio's contract: POST /posts needs `content` plus `platforms[]` of
 * { platform, accountId }. Both the key group and the account id are resolved
 * SERVER-SIDE from social_connections — the browser names a platform, never an
 * account.
 */

const KEY_GROUP_BY_PLATFORM: Record<string, ZernioKeyGroup> = {
  instagram: "tiktok_instagram",
  tiktok: "tiktok_instagram",
  facebook: "google_meta",
  linkedin: "google_meta",
  youtube: "google_meta",
};

// Zernio rejects any contentType outside this closed enum with a 400, so this
// must be the same list, not something inferred from the file extension.
const UPLOADABLE_MIME = [
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/mpeg", "video/quicktime", "video/avi", "video/x-msvideo",
  "video/webm", "video/x-m4v", "application/pdf",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a",
];

const MAX_CAROUSEL_ITEMS = 10;

type PostType = "feed" | "story" | "reel";

function mediaKind(mime: string): ZernioMediaItem["type"] {
  if (mime.startsWith("image/gif")) return "gif";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/**
 * Best-effort kind for a URL we are NOT declaring a type for. Used only to
 * label our own social_posts row — the type we send to Zernio stays omitted so
 * Zernio infers it (and never sees a type that contradicts the extension).
 */
function mediaKindFromUrl(url: string): ZernioMediaItem["type"] {
  const ext = (url.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase();
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) return "video";
  if (ext === "gif") return "gif";
  if (["pdf", "doc", "docx", "ppt", "pptx"].includes(ext)) return "document";
  return "image";
}

/** Only send contentType where the platform actually defines one. */
function platformSpecificDataFor(platform: string, postType: PostType): Record<string, unknown> | undefined {
  // contentType exists ONLY in Instagram's and Facebook's platform data in
  // Zernio's spec — LinkedIn, YouTube and TikTok define no such key, and an
  // unknown platform-data field fails that target's publish. The comment above
  // said this, but the story branch returned it for every platform anyway.
  const definesContentType = platform === "instagram" || platform === "facebook";
  if (!definesContentType) return undefined;
  if (postType === "story") return { contentType: "story" };
  // Instagram turns a single video into a Reel on its own; there is no "reel"
  // value in its contentType enum. Facebook needs it spelled out.
  if (postType === "reel" && platform === "facebook") return { contentType: "reel" };
  return undefined;
}

/** What this post will actually become, derived from media + intent. */
function resolvedContentType(postType: PostType, media: ZernioMediaItem[]): string {
  if (postType === "story") return "story";
  if (postType === "reel") return "reel";
  if (media.length > 1) return "carousel";
  if (media.length === 1) return media[0].type === "video" ? "video" : "image";  return "text";
}

export async function GET() {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data, error } = await supabase
    .from("social_posts")
    .select("id, platform, content_type, topic, caption, media_url, status, zernio_post_id, published_at")
    .order("published_at", { ascending: false, nullsFirst: true })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, posts: data ?? [] });
}

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  const platform = String(body.platform ?? "").toLowerCase() as ZernioPostPlatform;
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const postType: PostType = ["story", "reel"].includes(body.post_type) ? body.post_type : "feed";
  const scheduledFor = typeof body.scheduled_for === "string" && body.scheduled_for ? body.scheduled_for : undefined;
  const publishNow = Boolean(body.publish_now);
  const isDraft = Boolean(body.is_draft);
  const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : undefined;

  // Media may arrive as public URLs, as uploaded files, or (legacy) as a single
  // media_url / media_base64 pair.
  const urlsIn: string[] = Array.isArray(body.media_urls)
    ? body.media_urls.filter((u: unknown) => typeof u === "string" && u.trim()).map((u: string) => u.trim())
    : typeof body.media_url === "string" && body.media_url
      ? [body.media_url]
      : [];
  const uploadsIn: { base64: string; mime: string; filename?: string }[] = Array.isArray(body.media_uploads)
    ? body.media_uploads
    : typeof body.media_base64 === "string" && body.media_base64
      ? [{ base64: body.media_base64, mime: String(body.media_mime ?? ""), filename: body.media_filename }]
      : [];

  const keyGroup = KEY_GROUP_BY_PLATFORM[platform];
  if (!keyGroup) return NextResponse.json({ error: `Unsupported platform "${platform}"` }, { status: 400 });

  const totalMedia = urlsIn.length + uploadsIn.length;
  if (!caption && totalMedia === 0) {
    return NextResponse.json({ error: "A caption or some media is required" }, { status: 400 });
  }
  if (caption.length > 2200) {
    return NextResponse.json({ error: "Caption is too long (max 2200 characters)" }, { status: 400 });
  }
  if (totalMedia > MAX_CAROUSEL_ITEMS) {
    return NextResponse.json({ error: `At most ${MAX_CAROUSEL_ITEMS} media items are allowed` }, { status: 400 });
  }
  if (platform === "instagram" && postType !== "story" && totalMedia === 0) {
    return NextResponse.json(
      { error: "Instagram does not support text-only posts — attach an image or video." },
      { status: 400 }
    );
  }
  if (postType === "story" && totalMedia !== 1) {
    return NextResponse.json({ error: "A story needs exactly one image or video." }, { status: 400 });
  }
  for (const u of uploadsIn) {
    if (!UPLOADABLE_MIME.includes(u.mime)) {
      return NextResponse.json({ error: `Unsupported media type "${u.mime || "unknown"}"` }, { status: 400 });
    }
  }

  // The account id comes from OUR row for THIS client — never from the browser.
  const { data: connection } = await supabase
    .from("social_connections")
    .select("zernio_account_id, connection_status")
    .eq("client_id", client.id)
    .eq("platform", platform)
    .maybeSingle<{ zernio_account_id: string | null; connection_status: string }>();

  if (!connection || connection.connection_status !== "connected" || !connection.zernio_account_id) {
    return NextResponse.json({ error: `Connect ${platform} before publishing to it.` }, { status: 400 });
  }

  const admin = createAdminClient();

  // Record the intent first, so a failure AFTER Zernio accepted the post is
  // still visible in the Content page rather than vanishing.
  const { data: row, error: insertError } = await admin
    .from("social_posts")
    .insert({
      client_id: client.id,
      platform,
      content_type: resolvedContentType(postType, [
        ...urlsIn.map((u) => ({ type: mediaKindFromUrl(u), url: u })),
        ...uploadsIn.map((u) => ({ type: mediaKind(u.mime), url: "" })),
      ]),
      topic: typeof body.topic === "string" ? body.topic : null,
      caption,
      media_url: urlsIn[0] ?? null,
      status: "creating",
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !row) {
    return NextResponse.json({ error: `Could not record the post: ${insertError?.message}` }, { status: 500 });
  }

  try {
    // URL media: leave `type` OFF. Zernio infers it from the URL extension,
    // and rejects a type that contradicts that extension with a 400 — the
    // hardcoded `type: "image"` here failed every video-by-URL post
    // (…/clip.mp4 sent as an image), even though the composer offers video.
    const media: ZernioMediaItem[] = urlsIn.map((url) => ({ url }));

    for (const u of uploadsIn) {
      const uploaded = await uploadZernioMediaDirect(keyGroup, {
        bytes: Buffer.from(u.base64, "base64"),
        filename: u.filename ?? `upload.${u.mime.split("/")[1]}`,
        contentType: u.mime,
      });
      const url = uploaded.url ?? uploaded.mediaUrl;
      if (!url) throw new Error("Zernio did not return a media URL for the upload");
      media.push({ type: mediaKind(u.mime), url, mimeType: u.mime, filename: u.filename });
    }

    if (media.length && !urlsIn.length) {
      await admin.from("social_posts").update({ media_url: media[0].url }).eq("id", row.id);
    }

    const created = await createZernioPost(keyGroup, {
      content: caption,
      platforms: [
        {
          platform,
          accountId: connection.zernio_account_id,
          ...(platformSpecificDataFor(platform, postType)
            ? { platformSpecificData: platformSpecificDataFor(platform, postType) }
            : {}),
        },
      ],
      ...(media.length ? { mediaItems: media } : {}),
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(publishNow ? { publishNow: true } : {}),
      ...(isDraft ? { isDraft: true } : {}),
      ...(timezone ? { timezone } : {}),
      ...(typeof body.title === "string" && body.title ? { title: body.title } : {}),
    });

    // Zernio nests the created post under `post` on some responses and returns
    // it flat on others — accept both rather than reading a field that isn't there.
    const createdAny = created as { post?: { _id?: string; id?: string; status?: string } } & {
      _id?: string;
      id?: string;
      status?: string;
    };
    const createdPost = createdAny.post ?? createdAny;
    const providerId = String(createdPost?._id ?? createdPost?.id ?? "") || null;

    // "Scheduled" must mean Zernio has a schedule. With no scheduledFor,
    // publishNow and isDraft, Zernio saves a DRAFT — so recording "scheduled"
    // left the row claiming a publish that would never happen (the composer
    // allows submitting "Schedule" with the datetime left empty).
    const status = isDraft ? "draft" : publishNow ? "published" : scheduledFor ? "scheduled" : "draft";
    await admin
      .from("social_posts")
      .update({
        status,
        content_type: resolvedContentType(postType, media),
        zernio_post_id: providerId,
        published_at: publishNow ? new Date().toISOString() : null,
      })
      .eq("id", row.id);

    return NextResponse.json({
      ok: true,
      post: {
        id: row.id,
        status,
        content_type: resolvedContentType(postType, media),
        zernio_post_id: providerId,
        platform,
        caption,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    await admin.from("social_posts").update({ status: "failed" }).eq("id", row.id);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
