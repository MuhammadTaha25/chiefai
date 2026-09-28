import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeliveryStatusesForDomain, mailgunDomainForAddress } from "@/lib/mailgun";

/**
 * Powers the "View sent emails" expander under each mailbox row on the
 * Domains page — the mailbox-level counterpart to
 * /api/leads/[id]/outreach (which is per-lead). RLS scopes both `mailboxes`
 * and `outreach_log` to the caller's own client_id.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: mailboxId } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: mailbox } = await supabase
    .from("mailboxes")
    .select("id, address")
    .eq("id", mailboxId)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string; address: string }>();

  if (!mailbox) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("outreach_log")
    .select("id, subject, body, touch_number, sent_at, lead_id, leads(email, company)")
    .eq("mailbox_id", mailboxId)
    .order("sent_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Mailgun's event log is the source of truth for whether a send actually
  // reached the recipient — best-effort, since a Mailgun hiccup here
  // shouldn't hide the email list itself.
  const deliveryStatuses = await getDeliveryStatusesForDomain(mailgunDomainForAddress(mailbox.address)).catch(
    () => new Map()
  );

  const bouncedLeadIds = new Set<string>();
  const emails = (data ?? []).map((row) => {
    const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
    const recipient = (lead as { email: string | null } | null)?.email;
    const status = recipient ? deliveryStatuses.get(recipient) ?? "unknown" : "unknown";
    if (status === "bounced") bouncedLeadIds.add(row.lead_id);
    return { ...row, delivery_status: status };
  });

  // Stop wasting future follow-ups on addresses Mailgun has confirmed don't
  // exist — best-effort side effect of viewing this list, no separate
  // bounce-webhook registration required. Never blocks the response.
  if (bouncedLeadIds.size > 0) {
    const admin = createAdminClient();
    admin
      .from("leads")
      .update({ email_bounced: true, next_follow_up_at: null })
      .in("id", Array.from(bouncedLeadIds))
      .then(undefined, () => {});
  }

  return NextResponse.json({ emails });
}
