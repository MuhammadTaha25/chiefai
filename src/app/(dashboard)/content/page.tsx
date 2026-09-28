import { createClient } from "@/lib/supabase/server";
import type { SocialPost } from "@/types/db";
import ContentGrid from "@/components/content-grid";
import PostComposer from "@/components/post-composer";

export default async function ContentPage() {
  const supabase = await createClient();

  const { data: posts } = await supabase
    .from("social_posts")
    .select("*")
    .order("published_at", { ascending: false, nullsFirst: true })
    .limit(200)
    .returns<SocialPost[]>();

  // Only offer platforms that are actually connected — publishing needs a real
  // account behind it, and the server resolves the account id itself.
  const { data: connections } = await supabase
    .from("social_connections")
    .select("platform, connection_status")
    .eq("connection_status", "connected")
    .returns<{ platform: string; connection_status: string }[]>();

  const publishable = Array.from(
    new Set(
      (connections ?? [])
        .map((c) => c.platform)
        // facebook_ads / instagram_ads are ad accounts, not publishing targets.
        .filter((p) => p === "instagram" || p === "facebook" || p === "linkedin" || p === "tiktok" || p === "youtube")
    )
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Content calendar</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Create a post and publish it now, schedule it, or save it as a draft. Published posts appear below.
        </p>
      </div>
      <PostComposer platforms={publishable} />
      <ContentGrid posts={posts ?? []} />
    </div>
  );
}
