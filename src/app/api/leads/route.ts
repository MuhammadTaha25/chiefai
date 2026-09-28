import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Manual lead entry — the `leads` table only has a SELECT RLS policy (see
 * supabase/fix_all_client_rls.sql), no INSERT, so this goes through the
 * admin client scoped to the authenticated client.id, same pattern as the
 * mailboxes route. Exists for adding real leads by hand while automatic
 * prospecting (Explorium) isn't wired up yet.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { name, email, company, job_title } = await req.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const normalizedEmail = email.trim().toLowerCase();
  const { data: existing } = await admin
    .from("leads")
    .select("id")
    .eq("client_id", client.id)
    .eq("email", normalizedEmail)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "A lead with this email already exists" }, { status: 409 });
  }

  const { data, error } = await admin
    .from("leads")
    .insert({
      client_id: client.id,
      name: name || null,
      email: normalizedEmail,
      company: company || null,
      job_title: job_title || null,
      status: "new",
      lead_source: "manual",
      lead_type: "outbound",
    })
    .select()
    .single();

  if (error) {
    // 23505: lost a race against the unique (client_id, lower(email)) index.
    if (error.code === "23505") return NextResponse.json({ error: "A lead with this email already exists" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, lead: data });
}
