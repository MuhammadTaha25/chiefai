import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { uploadAdAsset } from "@/lib/storage";

// Meta's own limits for ad image/video uploads — reject oversized files here
// rather than letting them fail deep inside the launch route after the user
// has already filled out the rest of the ad brief.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MB

/**
 * Lets a user upload their own ad creative (image or video) instead of
 * letting Gemini generate one. The file is stored in the same public
 * "ad-creatives" bucket the AI-generated creative already uses, so the URL
 * this returns can be handed straight to Meta the same way.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  if (!isVideo && !isImage) {
    return NextResponse.json({ error: "Only image or video files are supported." }, { status: 400 });
  }

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `File is too large (${Math.round(file.size / 1024 / 1024)} MB). Max is ${Math.round(maxBytes / 1024 / 1024)} MB.` },
      { status: 400 }
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = isVideo ? "mp4" : (file.name.split(".").pop() || "png").toLowerCase();

  try {
    const url = await uploadAdAsset({
      bytes,
      contentType: file.type,
      // Timestamped so re-uploads within the same campaign draft don't race
      // each other's object path.
      objectPath: `${client.id}/user-upload-${Date.now()}.${ext}`,
    });
    return NextResponse.json({
      url,
      mediaType: isVideo ? "video" : "image",
      filename: file.name,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
