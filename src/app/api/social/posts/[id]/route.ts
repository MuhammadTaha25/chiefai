import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/** PATCH: update caption of a draft post. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const caption = typeof body.caption === "string" ? body.caption.trim() : null;
  if (caption === null) {
    return NextResponse.json({ error: "caption is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify post belongs to this client and is not yet published
  const { data: post } = await admin
    .from("social_posts")
    .select("id, status, client_id")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string; status: string | null; client_id: string }>();

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  if (post.status === "published") {
    return NextResponse.json({ error: "Cannot edit a published post" }, { status: 400 });
  }

  const { error } = await admin
    .from("social_posts")
    .update({ caption })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
