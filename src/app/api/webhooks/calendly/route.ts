import { logEvent } from "@/lib/log-event";
import { recordInviteeBooking } from "@/lib/calendly-bookings";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyCalendlySignature } from "@/lib/calendly";

/**
 * Per-client Calendly booking webhook (spec PHASE 9-12). The subscription
 * URL (created in /api/calendly/callback) carries `?client_id=` so we know
 * which client's row to check — but that query param alone proves nothing;
 * the request is only trusted once its signature verifies against THAT
 * specific client's own stored signing key. A wrong/forged client_id fails
 * verification (that client's real signing key won't match), so this can
 * never be used to attribute a booking to the wrong tenant.
 *
 * A Calendly page visit or link click never reaches this route at all —
 * only "invitee.created" (a real completed booking) does, which is the
 * spec's whole point: BOOKING (AI intent) is not BOOKED (an actual event).
 */
export async function POST(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get("client_id");
  if (!clientId) {
    return NextResponse.json({ error: "Missing client_id" }, { status: 400 });
  }

  const rawBody = await req.text();
  const admin = createAdminClient();

  const { data: client } = await admin
    .from("clients")
    .select("id, calendly_webhook_signing_key")
    .eq("id", clientId)
    .maybeSingle<{ id: string; calendly_webhook_signing_key: string | null }>();

  if (!client?.calendly_webhook_signing_key) {
    return NextResponse.json({ error: "Unknown client or no Calendly webhook configured" }, { status: 404 });
  }

  const signatureHeader = req.headers.get("calendly-webhook-signature");
  if (!verifyCalendlySignature(rawBody, signatureHeader, client.calendly_webhook_signing_key)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Signature already verified, but a signed body can still be malformed —
  // return a clean 400 instead of letting JSON.parse throw into a 500 (which
  // makes Calendly retry a request that can never succeed).
  let body: { event?: unknown; payload?: Record<string, unknown> };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof body.event !== "string") {
    return NextResponse.json({ error: "Missing event type" }, { status: 400 });
  }
  const eventType = body.event;
  const payload = (body.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  if (eventType === "invitee.canceled") {
    const invigeeUri = payload.uri as string | undefined;
    if (invigeeUri) {
      await admin
        .from("bookings")
        .update({ booking_status: "canceled", updated_at: new Date().toISOString() })
        .eq("calendly_event_id", invigeeUri)
        .eq("client_id", clientId);
      // Canceling doesn't automatically resume automated outreach — the
      // relationship already progressed past cold outreach; leave follow-ups
      // stopped and let the client decide manually (spec doesn't ask for
      // auto-resumption, and auto-resuming risks re-spamming someone who
      // cancelled for a reason).
    }
    return NextResponse.json({ ok: true, event: "invitee.canceled" });
  }

  if (eventType !== "invitee.created") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const calendlyEventId = payload.uri as string | undefined; // invitee URI — unique per booking
  const inviteeEmail = (payload.email as string | undefined)?.trim().toLowerCase();
  const scheduledEvent = payload.scheduled_event ?? {};

  if (!calendlyEventId || !inviteeEmail) {
    // Can't safely process — log for manual resolution rather than guessing
    // (spec PHASE 11: never mark an arbitrary lead BOOKED).
    // Identifiers only: never log the invitee's name/email/answers.
    logEvent("calendly.webhook_unresolved", { client_id: clientId, has_invitee_uri: Boolean(calendlyEventId), has_invitee_email: Boolean(inviteeEmail), result: "cannot_associate_booking" });
    return NextResponse.json({ ok: true, unresolved: true });
  }

  const result = await recordInviteeBooking(admin, clientId, {
    inviteeUri: calendlyEventId,
    email: inviteeEmail,
    startTime: scheduledEvent.start_time,
    endTime: scheduledEvent.end_time,
    eventTypeUri: scheduledEvent.event_type ?? null,
    scheduledEventUri: scheduledEvent.uri ?? null,
  });
  if (result.status === "deduped") return NextResponse.json({ ok: true, deduped: true });
  if (result.status === "unresolved") {
    logEvent("calendly.booking_unresolved", { client_id: clientId, provider_event_id: calendlyEventId, result: "no_matching_lead" });
    return NextResponse.json({ ok: true, unresolved: true, reason: result.reason });
  }
  if (result.status === "error") return NextResponse.json({ error: result.reason }, { status: 500 });
  return NextResponse.json({ ok: true, leadId: result.leadId, booked: true });
}
