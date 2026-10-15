import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findBookingsNeedingFeedback, sendFeedbackRequest } from "@/lib/meeting-feedback";

export const maxDuration = 60;

/**
 * Cron: runs every 30 minutes.
 * Finds meetings that ended 5–6 hours ago, sends feedback request to client
 * via email + in-app notification.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const bookings = await findBookingsNeedingFeedback(admin);

  const results = [];
  for (const booking of bookings) {
    const result = await sendFeedbackRequest(admin, booking);
    results.push({ bookingId: booking.id, ...result });
  }

  return NextResponse.json({ ok: true, processed: results.length, results });
}
