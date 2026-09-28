import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { calendly_url } = await req.json();
  if (typeof calendly_url !== "string") {
    return NextResponse.json({ error: "calendly_url must be a string" }, { status: 400 });
  }

  const admin = createAdminClient();
  // This link is emailed to prospects: only an empty value (clear) or an https URL is accepted.
  const trimmed = calendly_url.trim();
  if (trimmed && !/^https:\/\/[^\s]+$/.test(trimmed)) {
    return NextResponse.json({ error: "Enter a full https:// booking link" }, { status: 400 });
  }
  const { error } = await admin.from("clients").update({ calendly_url: trimmed }).eq("id", client.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
