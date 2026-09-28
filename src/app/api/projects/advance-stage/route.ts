import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Project stage change, handled in-app (previously forwarded to the inactive
 * n8n project-pipeline-advance-stage workflow). Route path kept for the UI.
 * Tenant is the session's client; the update is scoped to (id, client_id).
 */
// "not_started" is UI-only; the DB's initial state is "started" and is never a target.
const VALID_STATUSES = ["in_development", "qa", "client_review", "delivered", "closed"];

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { project_id?: string; new_status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const { project_id, new_status } = body;
  if (!project_id || !new_status || !VALID_STATUSES.includes(new_status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { data: updated, error } = await createAdminClient()
    .from("projects")
    .update({ status: new_status, updated_at: new Date().toISOString() })
    .eq("id", project_id)
    .eq("client_id", client.id)
    .select("id, status")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  // eslint-disable-next-line no-console
  console.log(`[projects] client=${client.id} project=${project_id} status->${new_status}`);
  return NextResponse.json({ ok: true, result: updated });
}
