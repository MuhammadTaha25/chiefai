import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** POST: submit meeting feedback */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();

  // Find booking by token
  const { data: booking } = await admin
    .from("bookings")
    .select("id, client_id, lead_id, feedback_submitted_at")
    .eq("feedback_token", token)
    .maybeSingle<{ id: string; client_id: string; lead_id: string | null; feedback_submitted_at: string | null }>();

  if (!booking) return NextResponse.json({ error: "Invalid or expired link" }, { status: 404 });
  if (booking.feedback_submitted_at) return NextResponse.json({ error: "Already submitted" }, { status: 409 });

  const body = await req.json();
  const { outcome, went_well, next_step, notes } = body;

  const validOutcomes = ["completed", "no_show", "rescheduled", "cancelled", "other"];
  if (!outcome || !validOutcomes.includes(outcome)) {
    return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
  }

  // Insert feedback
  const { error } = await admin.from("meeting_feedback").insert({
    booking_id: booking.id,
    client_id: booking.client_id,
    lead_id: booking.lead_id,
    outcome,
    went_well: went_well?.trim() || null,
    next_step: next_step || null,
    notes: notes?.trim() || null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mark booking feedback as submitted
  await admin
    .from("bookings")
    .update({ feedback_submitted_at: new Date().toISOString() })
    .eq("id", booking.id);

  // Update lead status based on outcome
  if (booking.lead_id) {
    if (outcome === "completed" && next_step === "close") {
      await admin.from("leads").update({ status: "closed_won" }).eq("id", booking.lead_id);
    } else if (outcome === "no_show") {
      await admin.from("leads").update({ status: "new" }).eq("id", booking.lead_id);
    }
  }

  return NextResponse.json({ ok: true });
}

/** GET: check token validity */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: booking } = await admin
    .from("bookings")
    .select("id, invitee_name, invitee_email, meeting_topic, scheduled_at, meeting_duration, feedback_submitted_at")
    .eq("feedback_token", token)
    .maybeSingle();

  if (!booking) return NextResponse.json({ error: "Invalid link" }, { status: 404 });

  return NextResponse.json({ booking });
}
