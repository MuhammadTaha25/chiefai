import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Deletes a mailbox row the client owns. Only removes our own bookkeeping —
 * doesn't touch the Mailgun route/domain, since those are shared/reused and
 * safe to just leave (Mailgun has no per-mailbox concept to clean up here,
 * only per-domain routes and domains).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Confirm this mailbox actually belongs to the authenticated client before
  // deleting — the write itself has to go through the admin client since
  // `mailboxes` has no DELETE RLS policy (only SELECT), same as the missing
  // INSERT policy worked around in the POST handler.
  const { data: existing } = await supabase
    .from("mailboxes")
    .select("id")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("mailboxes").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
