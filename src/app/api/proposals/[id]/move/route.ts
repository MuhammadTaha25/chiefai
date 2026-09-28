import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

const VALID_STATUSES = ["sent", "negotiation", "won", "lost"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const status = body.status ?? "";
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*, leads(name, company)")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();

  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  // The session client has no UPDATE policy on proposals (the update silently
  // matched 0 rows). Ownership was verified above, so write via admin, scoped
  // to (id, client_id).
  const { data: updated, error } = await createAdminClient()
    .from("proposals")
    .update({ status, decided_at: status === "won" || status === "lost" ? new Date().toISOString() : proposal.decided_at })
    .eq("id", id)
    .eq("client_id", client.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Deal won -> project, in-app (previously the inactive n8n deal-won workflow).
  // Only on the transition INTO "won", so re-clicking never creates duplicates.
  let project = null;
  if (status === "won" && proposal.status !== "won") {
    const lead = proposal.leads as { name: string | null; company: string | null } | null;
    const { data: created, error: projectError } = await createAdminClient()
      .from("projects")
      .insert({
        client_id: client.id,
        name: lead?.company || lead?.name || "New Project",
        // status omitted: the table default ("started") is the valid initial state
        revenue: proposal.amount ?? null,
      })
      .select("id")
      .single();
    if (projectError) {
      // Status change already saved — surface the failure without rolling back.
      return NextResponse.json({ ok: true, proposal: updated, project_error: projectError.message });
    }
    project = created;
    // eslint-disable-next-line no-console
    console.log(`[projects] client=${client.id} proposal=${id} won -> project=${created.id}`);
  }

  return NextResponse.json({ ok: true, proposal: updated, project });
}
