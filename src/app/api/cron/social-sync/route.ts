import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronRequest } from "@/lib/webhook-security";
import { listZernioPosts, type ZernioKeyGroup } from "@/lib/zernio";
import { logEvent } from "@/lib/log-event";

/**
 * Syncs the status of scheduled posts from Zernio back to our DB.
 *
 * Runs every 5 minutes. For each post in status="scheduled" with a
 * zernio_post_id, we check Zernio's record. If Zernio says it's published
 * (status "published" or "sent"), we update our row to published and set
 * published_at. If Zernio says it failed, we mark it failed.
 *
 * Auth: Vercel Cron (Authorization: Bearer $CRON_SECRET).
 */

const KEY_GROUP_BY_PLATFORM: Record<string, ZernioKeyGroup> = {
  instagram: "tiktok_instagram",
  tiktok: "tiktok_instagram",
  facebook: "google_meta",
  linkedin: "google_meta",
  youtube: "google_meta",
};

export async function GET(req: NextRequest) {
  if (!isCronRequest(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Find all posts that are still "scheduled" and have a Zernio post ID.
  const { data: pending, error } = await admin
    .from("social_posts")
    .select("id, platform, zernio_post_id, client_id")
    .eq("status", "scheduled")
    .not("zernio_post_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pending?.length) return NextResponse.json({ ok: true, synced: 0 });

  // Group by key group to batch the Zernio list calls.
  const byGroup = new Map<ZernioKeyGroup, typeof pending>();
  for (const row of pending) {
    const group = KEY_GROUP_BY_PLATFORM[row.platform?.split(",")[0] ?? ""];
    if (!group) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
  }

  let synced = 0;
  for (const [group, rows] of byGroup) {
    let zernioPosts: { _id?: string; id?: string; status?: string; publishedAt?: string; [key: string]: unknown }[] = [];
    try {
      const result = await listZernioPosts(group, { limit: 200 });
      zernioPosts = result.posts ?? [];
    } catch (err) {
      logEvent("social_sync.list_failed", { group, error: (err as Error).message });
      continue;
    }

    const zernioById = new Map(
      zernioPosts.map((p) => [String(p._id ?? p.id ?? ""), p])
    );

    for (const row of rows) {
      const zPost = zernioById.get(row.zernio_post_id!);
      if (!zPost) continue; // Not in Zernio's list yet — still pending

      const zStatus = String(zPost.status ?? "").toLowerCase();
      if (zStatus === "published" || zStatus === "sent" || zStatus === "posted") {
        const publishedAt = (zPost.publishedAt as string | undefined) ?? new Date().toISOString();
        await admin
          .from("social_posts")
          .update({ status: "published", published_at: publishedAt })
          .eq("id", row.id);
        logEvent("social_sync.published", { post_id: row.id, zernio_post_id: row.zernio_post_id });
        synced++;
      } else if (zStatus === "failed" || zStatus === "error") {
        await admin.from("social_posts").update({ status: "failed" }).eq("id", row.id);
        logEvent("social_sync.failed", { post_id: row.id, zernio_post_id: row.zernio_post_id, zernio_status: zStatus });
        synced++;
      }
    }
  }

  return NextResponse.json({ ok: true, synced, pending: pending.length });
}
