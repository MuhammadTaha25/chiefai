import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { pickReadyMailbox } from "@/lib/mailbox-readiness";

/** Generates a secure random token for the feedback form URL. */
export function generateFeedbackToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Public URL for the feedback form. */
export function feedbackFormUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/feedback/${token}`;
}

/**
 * Finds bookings that ended 5–6 hours ago and haven't had feedback sent yet.
 * "Ended" = scheduled_at + meeting_duration minutes.
 */
export async function findBookingsNeedingFeedback(
  admin: SupabaseClient
): Promise<
  Array<{
    id: string;
    client_id: string;
    lead_id: string | null;
    scheduled_at: string;
    meeting_duration: number;
    meeting_topic: string | null;
    invitee_name: string | null;
    invitee_email: string;
    feedback_token: string | null;
  }>
> {
  // Meeting ended = scheduled_at + meeting_duration minutes
  // We want: ended between 5h and 6h ago
  const now = new Date();
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();

  const { data } = await admin
    .from("bookings")
    .select("id, client_id, lead_id, scheduled_at, meeting_duration, meeting_topic, invitee_name, invitee_email, feedback_token")
    .eq("booking_status", "scheduled")
    .is("feedback_sent_at", null)
    .is("feedback_submitted_at", null)
    .not("scheduled_at", "is", null);

  if (!data) return [];

  // Filter in JS: meeting end time = scheduled_at + duration minutes
  return data.filter((b) => {
    if (!b.scheduled_at) return false;
    const endTime = new Date(new Date(b.scheduled_at).getTime() + (b.meeting_duration ?? 30) * 60 * 1000);
    return endTime >= new Date(sixHoursAgo) && endTime <= new Date(fiveHoursAgo);
  });
}

/**
 * Sends post-meeting feedback request to the client via email
 * and creates an in-app notification.
 */
export async function sendFeedbackRequest(
  admin: SupabaseClient,
  booking: {
    id: string;
    client_id: string;
    lead_id: string | null;
    invitee_name: string | null;
    invitee_email: string;
    meeting_topic: string | null;
    scheduled_at: string;
  }
): Promise<{ sent: boolean; reason?: string }> {
  // Get client info
  const { data: client } = await admin
    .from("clients")
    .select("email, auth_user_id, company_name, timezone")
    .eq("id", booking.client_id)
    .maybeSingle<{ email: string | null; auth_user_id: string | null; company_name: string | null; timezone: string | null }>();

  if (!client) return { sent: false, reason: "client not found" };

  // Resolve recipient email
  let recipient = client.email?.trim() || null;
  if (!recipient && client.auth_user_id) {
    const { data } = await admin.auth.admin.getUserById(client.auth_user_id);
    recipient = data?.user?.email ?? null;
  }
  if (!recipient) return { sent: false, reason: "no client email" };

  // Generate feedback token
  const token = generateFeedbackToken();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://infomistqa4827.online";
  const formUrl = feedbackFormUrl(token, baseUrl);

  // Save token to booking
  await admin
    .from("bookings")
    .update({ feedback_token: token, feedback_sent_at: new Date().toISOString() })
    .eq("id", booking.id);

  const leadName = booking.invitee_name || booking.invitee_email;
  const topic = booking.meeting_topic || "your meeting";
  const when = new Date(booking.scheduled_at).toLocaleString("en-US", {
    timeZone: client.timezone ?? "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  // 1. Send email to client
  const mailbox = await pickReadyMailbox(admin, booking.client_id);
  if (mailbox) {
    const domain = mailgunDomainForAddress(mailbox.address);
    const lines = [
      `Hi,`,
      ``,
      `Your meeting with ${leadName} (${topic}) was scheduled for ${when}.`,
      ``,
      `How did it go? Let us know so we can plan the right follow-up:`,
      ``,
      formUrl,
      ``,
      `It takes less than a minute.`,
      ``,
      `— ChiefAI`,
    ];
    await sendMail({
      domain,
      from: mailbox.address,
      to: recipient,
      subject: `How did your meeting with ${leadName} go?`,
      text: lines.join("\n"),
    }).catch(() => {});
  }

  // 2. Create in-app notification
  await admin.from("client_notifications").insert({
    client_id: booking.client_id,
    type: "meeting_feedback",
    title: `How did your meeting with ${leadName} go?`,
    body: `Your ${topic} meeting was ${when}. Fill in a quick update.`,
    action_url: formUrl,
  });

  return { sent: true };
}
