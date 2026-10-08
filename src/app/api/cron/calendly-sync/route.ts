import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { getFreshCalendlyToken, listRecentInvitees } from "@/lib/calendly";
import { recordInviteeBooking, sendBookingNotifications } from "@/lib/calendly-bookings";
import type { BookingContext } from "@/lib/booking-notification";

/**
 * Polling fallback for Calendly bookings. Calendly only allows webhook
 * subscriptions on paid plans (confirmed live: 403 "Please upgrade your
 * Calendly account to Standard"), so for connected clients WITHOUT a webhook
 * this reads their scheduled events/invitees directly (allowed on every plan)
 * and feeds them through the same recorder the webhook uses. Clients that do
 * have a webhook are skipped — the webhook stays the primary path.
 *
 * Runs on a schedule (Bearer $CRON_SECRET) or, from the dashboard, for the
 * authenticated client only. Never trusts a client_id from the request.
 */
async function run(req: NextRequest) {
  const admin = createAdminClient();
  const cronSecret = process.env.CRON_SECRET;
  const isCron = Boolean(cronSecret) && req.headers.get("authorization") === `Bearer ${cronSecret}`;

  let onlyClient: string | null = null;
  if (!isCron) {
    const { user, client } = await getCurrentClient();
    if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    onlyClient = client.id;
  }

  let q = admin
    .from("clients")
    .select("id, calendly_access_token, calendly_refresh_token, calendly_token_expires_at, calendly_user_uri")
    .not("calendly_access_token", "is", null)
    .is("calendly_webhook_uri", null);
  if (onlyClient) q = q.eq("id", onlyClient);
  const { data: clients } = await q;

  const results: { clientId: string; booked: number; deduped: number; unresolved: number; canceled: number; error?: string }[] = [];
  for (const c of clients ?? []) {
    const r = { clientId: c.id, booked: 0, deduped: 0, unresolved: 0, canceled: 0 } as (typeof results)[number];
    try {
      const token = await getFreshCalendlyToken(admin, c);
      if (!token || !c.calendly_user_uri) throw new Error("Calendly token unavailable — reconnect Calendly");
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      for (const inv of await listRecentInvitees(token, c.calendly_user_uri, since)) {
        if (inv.status === "canceled") {
          const { data: upd } = await admin
            .from("bookings")
            .update({ booking_status: "canceled", updated_at: new Date().toISOString() })
            .eq("calendly_event_id", inv.inviteeUri)
            .eq("client_id", c.id)
            .neq("booking_status", "canceled")
            .select("id");
          if (upd?.length) r.canceled++;
          continue;
        }
        const res = await recordInviteeBooking(admin, c.id, inv);
        if (res.status === "booked") r.booked++;
        else if (res.status === "deduped") r.deduped++;
        else if (res.status === "unresolved") r.unresolved++;
        else r.error = res.reason;
      }
    } catch (err) {
      r.error = (err as Error).message;
    }
    results.push(r);
  }

  // Retry sweep: a notification that failed on first attempt (e.g. a
  // transient Mailgun error, or the client's only mailbox temporarily
  // unverified) has no other path back to "sent" — this cron already runs on
  // a schedule, so it doubles as the retry mechanism. Only the SPECIFIC
  // notification(s) still marked failed are re-sent; one already "sent" is
  // never touched, so no duplicate email can result from a retry.
  // 'permanently_failed' never matches `eq.failed`, so once a notification
  // hits MAX_NOTIFICATION_ATTEMPTS (see sendBookingNotifications) the sweep
  // naturally stops picking it up — no separate cap-tracking needed here.
  let bq = admin
    .from("bookings")
    .select(
      "calendly_event_id, client_id, lead_id, invitee_email, invitee_name, invitee_timezone, meeting_location, cancel_url, reschedule_url, event_name, meeting_topic, scheduled_at, meeting_duration, client_notification_status, customer_notification_status, client_notification_attempts, customer_notification_attempts"
    )
    .eq("booking_status", "scheduled")
    .or("client_notification_status.eq.failed,customer_notification_status.eq.failed");
  if (onlyClient) bq = bq.eq("client_id", onlyClient);
  const { data: failedBookings } = await bq;

  let retried = 0;
  for (const row of failedBookings ?? []) {
    const endTime =
      row.scheduled_at && row.meeting_duration
        ? new Date(new Date(row.scheduled_at).getTime() + row.meeting_duration * 60000).toISOString()
        : undefined;
    const context: BookingContext = {
      startTime: row.scheduled_at ?? undefined,
      endTime,
      inviteeEmail: row.invitee_email ?? "",
      inviteeName: row.invitee_name,
      inviteeTimezone: row.invitee_timezone,
      meetingLocation: row.meeting_location,
      cancelUrl: row.cancel_url,
      rescheduleUrl: row.reschedule_url,
      eventName: row.event_name,
      meetingTopic: row.meeting_topic,
    };
    await sendBookingNotifications(
      admin,
      row.client_id,
      row.lead_id,
      row.calendly_event_id,
      context,
      {
        client: row.client_notification_status === "failed",
        customer: row.customer_notification_status === "failed",
      },
      {
        client: row.client_notification_attempts ?? 0,
        customer: row.customer_notification_attempts ?? 0,
      }
    );
    retried++;
  }

  return NextResponse.json({ ok: true, results, notificationsRetried: retried });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
