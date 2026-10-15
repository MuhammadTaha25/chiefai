import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { client } = await getCurrentClient();
  if (!client) return NextResponse.json({ error: "No client found" }, { status: 404 });

  const body = await req.json();
  const limit = Number(body.daily_send_limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "daily_send_limit must be 1–200" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Verify this mailbox belongs to this client
  const { data: mailbox } = await admin
    .from("mailboxes")
    .select("id")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  if (!mailbox) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await admin
    .from("mailboxes")
    .update({ daily_send_limit: limit })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, daily_send_limit: limit });
}
