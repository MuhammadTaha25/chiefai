/**
 * Server-only Supabase Storage helper.
 *
 * Exists because Meta cannot be handed raw bytes for a creative it must fetch:
 * both the ad-image upload and the ad-video upload endpoints want either a
 * PUBLIC https URL or a base64 body. AI-generated video is far too large for
 * the base64 body cap (Zernio documents `videoBase64` as limited by the
 * host's request size, which is why a 2 MB MP4 is already marginal), so the
 * generated file is parked in a public bucket and Zernio is given the URL.
 *
 * The bucket is created out-of-band (see the `ad-creatives` bucket) and must be
 * PUBLIC — Zernio fetches it anonymously.
 */
const BUCKET = process.env.SUPABASE_AD_BUCKET ?? "ad-creatives";

function config(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase Storage is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  return { url, key };
}

/** Public URL for an object already in the ads bucket. */
export function publicAdAssetUrl(objectPath: string): string {
  const { url } = config();
  return `${url}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/**
 * Uploads bytes to the public ads bucket and returns the public URL.
 * Uses the service-role key (server only) and upserts, so a retry of the same
 * logical asset replaces the object instead of failing on a duplicate.
 */
export async function uploadAdAsset(params: {
  bytes: Uint8Array;
  contentType: string;
  objectPath: string;
}): Promise<string> {
  const { url, key } = config();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${params.objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": params.contentType,
      "x-upsert": "true",
    },
    // A Uint8Array is a valid BodyInit at runtime; the DOM lib's generic
    // ArrayBufferLike parameter is what trips the compiler, not the value.
    body: params.bytes as unknown as BodyInit,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const publicUrl = publicAdAssetUrl(params.objectPath);

  // Verify the object is actually publicly readable before handing the URL to
  // Meta — a private bucket would otherwise fail deep inside the ad launch with
  // a confusing "could not download media" error.
  const check = await fetch(publicUrl, { method: "HEAD" });
  if (!check.ok) {
    throw new Error(
      `Uploaded to Storage but the public URL is not readable (${check.status}). Is the "${BUCKET}" bucket public?`
    );
  }

  return publicUrl;
}
