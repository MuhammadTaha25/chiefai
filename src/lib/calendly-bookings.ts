import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyClientOfBooking } from "@/lib/booking-notification";
import { logEvent } from "@/lib/log-event";

/**
 * The single place a Calendly booking becomes app state — used by BOTH the
 * (paid-plan) webhook and the polling sync, so the two paths can never drift
 * apart. Tenant safety: the invitee is matched only against THIS client's own
 * leads, never globally.
 *
 * Idempotent: bookings.calendly_event_id (the invitee URI) is unique, so a
 * redelivered webhook or a repeated sync hits 23505 and becomes a no-op.
 */
export async function recordInviteeBooking(
  admin: SupabaseClient,
  clientId: string,
  b: {
    inviteeUri: string;
    email: string;
    startTime?: string;
    endTime?: string;
    eventTypeUri?: string | null;
    scheduledEventUri?: string | null;
  }
): Promise<{ status: "booked" | "deduped" | "unresolved" | "error"; leadId?: string; reason?: string }> {
  const email = b.email.trim().toLowerCase();
  const meetingDuration =
    b.startTime && b.endTime ? Math.round((new Date(b.endTime).getTime() - new Date(b.startTime).getTime()) / 60000) : 30;

  const { data: lead } = await admin
    .from("leads")
    .select("id, campaign_id")
    .eq("client_id", clientId)
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; campaign_id: string | null }>();
  if (!lead) return { status: "unresolved", reason: "no matching lead" };

  const { error: insertError } = await admin.from("bookings").insert({
    client_id: clientId,
    lead_id: lead.id,
    campaign_id: lead.campaign_id,
    calendly_event_id: b.inviteeUri,
    booking_status: "scheduled",
    invitee_email: email,
    scheduled_at: b.startTime ?? null,
    meeting_duration: meetingDuration,
    event_type: b.eventTypeUri ?? null,
    booking_url: b.scheduledEventUri ?? null,
  });
  if (insertError) {
    if (insertError.code === "23505") return { status: "deduped", leadId: lead.id };
    return { status: "error", reason: insertError.message };
  }

  // `booked` is the authoritative signal (leads.status has a check constraint
  // that doesn't allow a "booked" value).
  await admin.from("leads").update({ booked: true, next_follow_up_at: null }).eq("id", lead.id);

  if (lead.campaign_id) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("booking_count")
      .eq("id", lead.campaign_id)
      .maybeSingle<{ booking_count: number }>();
    await admin
      .from("campaigns")
      .update({ booking_count: (campaign?.booking_count ?? 0) + 1 })
      .eq("id", lead.campaign_id);
  }
  // Reached only when THIS call inserted the booking (a duplicate returns
  // "deduped" above), so the client is notified exactly once per booking.
  const note = await notifyClientOfBooking(admin, clientId, lead.id, {
    startTime: b.startTime,
    endTime: b.endTime,
    scheduledEventUri: b.scheduledEventUri,
    inviteeEmail: email,
  }).catch((e) => ({ sent: false, reason: (e as Error).message }));
  if (!note.sent) {
    // eslint-disable-next-line no-console
    console.error(`Booking notification not sent for client ${clientId}: ${note.reason}`);
  }
  logEvent("booking.recorded", { client_id: clientId, lead_id: lead.id, campaign_id: lead.campaign_id, provider_event_id: b.inviteeUri, notified: note.sent, result: "booked" });
  return { status: "booked", leadId: lead.id };
}
