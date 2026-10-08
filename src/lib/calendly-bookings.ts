import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyClientOfBooking, notifyCustomerOfBooking } from "@/lib/booking-notification";
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
    name?: string | null;
    timezone?: string | null;
    cancelUrl?: string | null;
    rescheduleUrl?: string | null;
    eventName?: string | null;
    location?: string | null;
  }
): Promise<{ status: "booked" | "deduped" | "unresolved" | "error"; leadId?: string; reason?: string }> {
  const email = b.email.trim().toLowerCase();
  const meetingDuration =
    b.startTime && b.endTime ? Math.round((new Date(b.endTime).getTime() - new Date(b.startTime).getTime()) / 60000) : 30;

  // meeting_topic was generated (if at all) the moment this lead's reply was
  // classified BOOKING — see src/app/api/webhooks/mailgun/route.ts — and
  // carried on the lead row from there, so the booking record inherits
  // exactly what the conversation was actually about, not a re-guess.
  const { data: lead } = await admin
    .from("leads")
    .select("id, campaign_id, meeting_topic")
    .eq("client_id", clientId)
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; campaign_id: string | null; meeting_topic: string | null }>();
  if (!lead) return { status: "unresolved", reason: "no matching lead" };

  const meetingTopic = lead.meeting_topic || null;

  const { error: insertError } = await admin.from("bookings").insert({
    client_id: clientId,
    lead_id: lead.id,
    campaign_id: lead.campaign_id,
    calendly_event_id: b.inviteeUri,
    booking_status: "scheduled",
    invitee_email: email,
    invitee_name: b.name ?? null,
    invitee_timezone: b.timezone ?? null,
    meeting_location: b.location ?? null,
    cancel_url: b.cancelUrl ?? null,
    reschedule_url: b.rescheduleUrl ?? null,
    event_name: b.eventName ?? null,
    meeting_topic: meetingTopic,
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
  // "deduped" above), so both notifications fire exactly once per booking —
  // true even when the webhook and the polling fallback both see the same
  // event, since only one of them wins the unique-constraint insert.
  const bookingContext = {
    startTime: b.startTime,
    endTime: b.endTime,
    scheduledEventUri: b.scheduledEventUri,
    inviteeEmail: email,
    inviteeName: b.name ?? null,
    inviteeTimezone: b.timezone ?? null,
    meetingLocation: b.location ?? null,
    cancelUrl: b.cancelUrl ?? null,
    rescheduleUrl: b.rescheduleUrl ?? null,
    eventName: b.eventName ?? null,
    meetingTopic,
  };

  // A notification failing must never un-confirm a real booking — each
  // outcome is recorded on the row (and left "pending" is never possible
  // past this point) so a failed send can be told apart from one that was
  // never attempted, and safely retried later without re-booking anything.
  const clientNote = await notifyClientOfBooking(admin, clientId, lead.id, bookingContext).catch((e) => ({
    sent: false,
    reason: (e as Error).message,
  }));
  if (!clientNote.sent) {
    // eslint-disable-next-line no-console
    console.error(`Client booking notification not sent for client ${clientId}: ${clientNote.reason}`);
  }

  const customerNote = await notifyCustomerOfBooking(admin, clientId, lead.id, bookingContext).catch((e) => ({
    sent: false,
    reason: (e as Error).message,
  }));
  if (!customerNote.sent) {
    // eslint-disable-next-line no-console
    console.error(`Customer booking confirmation not sent for client ${clientId}: ${customerNote.reason}`);
  }

  await admin
    .from("bookings")
    .update({
      client_notification_status: clientNote.sent ? "sent" : "failed",
      customer_notification_status: customerNote.sent ? "sent" : "failed",
    })
    .eq("calendly_event_id", b.inviteeUri)
    .eq("client_id", clientId);

  logEvent("booking.recorded", {
    client_id: clientId,
    lead_id: lead.id,
    campaign_id: lead.campaign_id,
    provider_event_id: b.inviteeUri,
    client_notified: clientNote.sent,
    customer_notified: customerNote.sent,
    result: "booked",
  });
  return { status: "booked", leadId: lead.id };
}
