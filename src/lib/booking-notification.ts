import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { pickReadyMailbox } from "@/lib/mailbox-readiness";

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
  booking: { startTime?: string; endTime?: string; scheduledEventUri?: string | null; inviteeEmail: string }
): Promise<{ sent: boolean; reason?: string }> {
  const { data: client } = await admin
    .from("clients")
    .select("email, auth_user_id, company_name")
    .eq("id", clientId)
    .maybeSingle<{ email: string | null; auth_user_id: string | null; company_name: string | null }>();
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

  const when = booking.startTime
    ? new Date(booking.startTime).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }) + " UTC"
    : "time not provided";
  const lines = [
    `${lead?.name || booking.inviteeEmail} just booked a call with ${client.company_name ?? "you"} through your Calendly.`,
    "",
    `Prospect: ${lead?.name ?? "-"}${lead?.job_title ? ` (${lead.job_title})` : ""}`,
    `Company: ${lead?.company ?? "-"}`,
    `Email: ${booking.inviteeEmail}`,
    `When: ${when}`,
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
