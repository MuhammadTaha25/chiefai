import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";
import { resolveFollowUpIntervalMs } from "@/lib/follow-up-config";

/**
 * Actually sends an (AI-drafted or edited) email to a lead, from the
 * client's first mailbox, and records it in outreach_log so it shows up in
 * the per-lead sent-email history on the Leads page. Updates the lead's
 * status/last_contact_at too — this is the in-app replacement for the old
 * n8n send step.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { subject, body, confirm_override } = await req.json();
  if (!subject || !body || typeof subject !== "string" || typeof body !== "string") {
    return NextResponse.json({ error: "subject and body are required" }, { status: 400 });
  }

  const { data: lead } = await supabase
    .from("leads")
    .select("id, email, follow_up_number, unsubscribed, complained, email_bounced, reply_received, booked, manually_stopped")
    .eq("id", leadId)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string; email: string; follow_up_number: number | null; unsubscribed: boolean | null; complained: boolean | null; email_bounced: boolean | null; reply_received: boolean | null; booked: boolean | null; manually_stopped: boolean | null }>();

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }
  if (!lead.email) {
    return NextResponse.json({ error: "This lead has no email address" }, { status: 400 });
  }
  if (lead.unsubscribed) {
    return NextResponse.json({ error: "This lead has unsubscribed — cannot send" }, { status: 400 });
  }
  // Hard stops that no human decision should override: a spam complaint or a hard bounce means further
  // mail to this address harms the sender's reputation (and breaks provider rules) regardless of intent.
  if (lead.complained) {
    return NextResponse.json({ error: "This lead reported spam — cannot send" }, { status: 400 });
  }
  if (lead.email_bounced) {
    return NextResponse.json({ error: "This address bounced — cannot send" }, { status: 400 });
  }

  // Owner-approved policy: a lead that replied, booked or was manually stopped needs an explicit human confirmation.
  const softStops = [lead.reply_received && "replied", lead.booked && "booked a meeting", lead.manually_stopped && "was manually stopped"].filter(Boolean) as string[];
  if (softStops.length > 0 && confirm_override !== true) {
    return NextResponse.json(
      { error: `This lead ${softStops.join(" and ")}. Confirm to send anyway.`, code: "needs_confirm" },
      { status: 409 }
    );
  }

  const admin = createAdminClient();
  const touchNumber = (lead.follow_up_number ?? 0) + 1;

  // The follow-up cadence comes from the client's lead-gen criteria (the same source the follow-up cron uses),
  // not a hardcoded number of days.
  const { data: job } = await admin
    .from("lead_gen_jobs")
    .select("criteria")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ criteria: Record<string, unknown> }>();

  // Any email after the first must come from the SAME mailbox that sent the lead's first email (and thread onto
  // the last real message). Looked up BEFORE reserving a slot, so this send's own "pending:" reservation row can
  // never be mistaken for the previous message.
  let pinnedMailboxId: string | undefined;
  let inReplyTo: string | undefined;
  if (touchNumber > 1) {
    const [{ data: firstSend }, { data: prevSend }] = await Promise.all([
      admin
        .from("outreach_log")
        .select("mailbox_id")
        .eq("client_id", client.id)
        .eq("lead_id", lead.id)
        .not("mailbox_id", "is", null)
        .order("sent_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ mailbox_id: string }>(),
      admin
        .from("outreach_log")
        .select("provider_message_id")
        .eq("client_id", client.id)
        .eq("lead_id", lead.id)
        .not("provider_message_id", "is", null)
        .not("provider_message_id", "like", "pending:%")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ provider_message_id: string }>(),
    ]);
    pinnedMailboxId = firstSend?.mailbox_id ?? undefined;
    inReplyTo = prevSend?.provider_message_id ?? undefined;
  }
  const pinnedNote = pinnedMailboxId ? " (follow-ups always go out from the mailbox that sent the first email)" : "";

  // Reserve a slot on a ready mailbox of this tenant that is under its daily limit (atomic), BEFORE sending.
  const reservation = await reserveMailboxSlot(
    admin,
    client.id,
    lead.id,
    { touch_number: touchNumber, subject, body },
    pinnedMailboxId ? { mailboxId: pinnedMailboxId } : undefined,
  );
  if (!reservation.ok) {
    return NextResponse.json(
      {
        error:
          (reservation.reason === "at_capacity"
            ? "Daily sending capacity reached for the mailbox that must send this — try again tomorrow"
            : reservation.reason === "all_unhealthy"
              ? "Your mailboxes are paused because of a high bounce/complaint rate — add a new mailbox under Domains or review your lead list"
              : "No verified mailbox available — finish mailbox/DNS setup under Domains first") + pinnedNote,
        code: reservation.reason,
      },
      { status: reservation.reason === "at_capacity" ? 429 : 400 }
    );
  }
  const mailbox = reservation.mailbox;

  // REGRESSION FIX (Final Regression Audit, 2026-10-09): this manual
  // per-lead send path was missed by the original P0 fix's "every sending
  // path" sweep — it reserved a mailbox slot but never re-checked domain
  // ownership/disconnected state before sending.
  const mailboxDomain = mailgunDomainForAddress(mailbox.address);
  const externalDomains = await getExternalDomainsForClient(admin, client.id);
  const usable = await assertDomainUsableByClient(admin, client.id, mailboxDomain, { requireExplicitOwnership: externalDomains.has(mailboxDomain) });
  if (!usable.usable || (await isDomainDisconnected(admin, client.id, mailboxDomain))) {
    await releaseReservation(admin, reservation.reservationId);
    return NextResponse.json({ error: `Domain ${mailboxDomain} is not usable (ownership unverified or disconnected)` }, { status: 403 });
  }

  let sentMsgId: string | undefined;
  try {
    sentMsgId = (
      await sendMail({
        inReplyTo,
        domain: mailgunDomainForAddress(mailbox.address),
        // Same sender display name as the automated sends (send-batch / follow-ups), so a lead sees one consistent
        // sender across the thread, and it looks like a business rather than a bare address.
        from: `${(client.company_name ?? "").replace(/["<>\r\n]/g, "").trim() || "Team"} <${mailbox.address}>`,
        to: lead.email,
        subject,
        text: withUnsubscribeFooter(body, { company: client.company_name, postalAddress: (client as { postal_address?: string | null }).postal_address }),
        headers: unsubscribeHeaders(mailbox.address),
      })
    ).id;
  } catch (err) {
    await releaseReservation(admin, reservation.reservationId);
    return NextResponse.json({ error: `Send failed: ${(err as Error).message}` }, { status: 502 });
  }

  await Promise.all([
    finalizeReservation(admin, reservation.reservationId, { messageId: sentMsgId, subject, body }),
    admin
      .from("leads")
      .update({
        status: touchNumber === 1 ? "email_sent" : `follow_up_${Math.min(touchNumber - 1, 10)}`,
        follow_up_number: touchNumber,
        last_contact_at: new Date().toISOString(),
        // Follow-up #1 is scheduled ONLY here, after a successful send (GENERATED != CONTACTED).
        next_follow_up_at: new Date(Date.now() + resolveFollowUpIntervalMs(job?.criteria)).toISOString(),
      })
      .eq("id", lead.id),
  ]);

  return NextResponse.json({ ok: true });
}
