import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { pickReadyMailbox } from "@/lib/mailbox-readiness";

export interface BookingContext {
  startTime?: string;
  endTime?: string;
  scheduledEventUri?: string | null;
  inviteeEmail: string;
  inviteeName?: string | null;
  inviteeTimezone?: string | null;
  meetingLocation?: string | null;
  cancelUrl?: string | null;
  rescheduleUrl?: string | null;
  /** The Calendly Event Type's own static name, e.g. "Discovery / Consultation Call". */
  eventName?: string | null;
  /** The conversation-derived dynamic subject, if one was generated — never invented here. */
  meetingTopic?: string | null;
}

/** Formats an ISO timestamp for display in a given IANA timezone, with the zone always shown explicitly (never a bare, ambiguous time). */
function formatInZone(iso: string | undefined, timeZone: string | null | undefined): string {
  if (!iso) return "time not provided";
  const zone = timeZone || "UTC";
  try {
    const formatted = new Date(iso).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: zone });
    return `${formatted} (${zone})`;
  } catch {
    // An invalid/unrecognized IANA zone string falls back to UTC rather than throwing.
    return `${new Date(iso).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" })} (UTC)`;
  }
}

/**
 * In-app notification to the CLIENT when one of their leads books through
 * Calendly. Calendly's own notification goes to the Calendly account owner;
 * this one goes to the client's Infomist contact address, and includes the
 * lead/campaign context Calendly doesn't have.
 *
 * Recipient is resolved from the tenant's own records only — clients.email,
 * else the email of the auth user that owns the client. Never a fixed address.
 * Called only after a booking row was actually inserted (the unique invitee
 * URI makes that happen once), so duplicate webhook/sync deliveries can never
 * notify twice.
 */
export async function notifyClientOfBooking(
  admin: SupabaseClient,
  clientId: string,
  leadId: string,
  booking: BookingContext
): Promise<{ sent: boolean; reason?: string }> {
  const { data: client } = await admin
    .from("clients")
    .select("email, auth_user_id, company_name, timezone")
    .eq("id", clientId)
    .maybeSingle<{ email: string | null; auth_user_id: string | null; company_name: string | null; timezone: string | null }>();
  if (!client) return { sent: false, reason: "client not found" };

  let recipient = client.email?.trim() || null;
  if (!recipient && client.auth_user_id) {
    const { data } = await admin.auth.admin.getUserById(client.auth_user_id);
    recipient = data?.user?.email ?? null;
  }
  if (!recipient) return { sent: false, reason: "no client email on record" };

  const mailbox = await pickReadyMailbox(admin, clientId);
  if (!mailbox) return { sent: false, reason: "no verified mailbox to send from" };

  const { data: lead } = await admin
    .from("leads")
    .select("name, company, job_title, email")
    .eq("id", leadId)
    .eq("client_id", clientId)
    .maybeSingle<{ name: string | null; company: string | null; job_title: string | null; email: string | null }>();

  // Falls back to UTC (explicitly labelled) when the client hasn't set a
  // timezone — never a bare, ambiguous time.
  const when = formatInZone(booking.startTime, client.timezone);
  const lines = [
    `${lead?.name || booking.inviteeEmail} just booked a call with ${client.company_name ?? "you"} through your Calendly.`,
    "",
    `Prospect: ${lead?.name ?? "-"}${lead?.job_title ? ` (${lead.job_title})` : ""}`,
    `Company: ${lead?.company ?? "-"}`,
    `Email: ${booking.inviteeEmail}`,
    `When: ${when}`,
    `Topic: ${booking.meetingTopic || booking.eventName || "Discovery / Consultation Call"}`,
    booking.scheduledEventUri ? `Calendly event: ${booking.scheduledEventUri}` : "",
    "",
    "Automated follow-ups to this lead have been stopped.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");

  try {
    await sendMail({
      domain: mailgunDomainForAddress(mailbox.address),
      from: mailbox.address,
      to: recipient,
      subject: `New booking: ${lead?.name || booking.inviteeEmail}`,
      text: lines.join("\n"),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err as Error).message };
  }
}

/**
 * Application-generated confirmation to the CUSTOMER (the Calendly invitee)
 * — separate from whatever Calendly's own native notification does. If
 * Calendly's email fails to send, gets filtered, or the invitee mistyped
 * nothing in our flow, the lead otherwise gets silently booked with zero
 * confirmation from us. Only ever called after a real booking row exists
 * (never on mere "wants to book" intent).
 *
 * Sent from the SAME mailbox/domain the client's outreach already uses, so
 * it threads naturally and isn't a surprise new sender.
 */
export async function notifyCustomerOfBooking(
  admin: SupabaseClient,
  clientId: string,
  leadId: string,
  booking: BookingContext
): Promise<{ sent: boolean; reason?: string }> {
  const recipient = booking.inviteeEmail.trim();
  if (!recipient) return { sent: false, reason: "no customer email" };

  const { data: client } = await admin
    .from("clients")
    .select("company_name")
    .eq("id", clientId)
    .maybeSingle<{ company_name: string | null }>();
  if (!client) return { sent: false, reason: "client not found" };

  const mailbox = await pickReadyMailbox(admin, clientId);
  if (!mailbox) return { sent: false, reason: "no verified mailbox to send from" };

  const { data: lead } = await admin
    .from("leads")
    .select("name")
    .eq("id", leadId)
    .eq("client_id", clientId)
    .maybeSingle<{ name: string | null }>();

  const businessName = client.company_name ?? "us";
  const customerName = booking.inviteeName || lead?.name || "there";
  // The invitee's own Calendly-reported timezone when available — otherwise
  // UTC, always labelled.
  const when = formatInZone(booking.startTime, booking.inviteeTimezone);
  const duration =
    booking.startTime && booking.endTime
      ? `${Math.round((new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime()) / 60000)} minutes`
      : null;
  const topic = booking.meetingTopic || booking.eventName || "Discovery / Consultation Call";

  const lines = [
    `Hi ${customerName},`,
    "",
    `This confirms your meeting with ${businessName}.`,
    "",
    `Topic: ${topic}`,
    `When: ${when}`,
    duration ? `Duration: ${duration}` : "",
    booking.meetingLocation ? `Where: ${booking.meetingLocation}` : "",
    "",
    booking.rescheduleUrl ? `Need a different time? Reschedule: ${booking.rescheduleUrl}` : "",
    booking.cancelUrl ? `Can't make it? Cancel: ${booking.cancelUrl}` : "",
    "",
    `Looking forward to speaking with you.`,
    `— ${businessName}`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");

  try {
    await sendMail({
      domain: mailgunDomainForAddress(mailbox.address),
      from: mailbox.address,
      to: recipient,
      subject: `Confirmed: ${topic} with ${businessName}`,
      text: lines.join("\n"),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err as Error).message };
  }
}
