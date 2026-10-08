import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMailgunDomain, getMailgunDnsRecords } from "@/lib/mailgun";

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i;

/**
 * Registers a domain the client already owns elsewhere (not bought through
 * us via Hostinger) so they can set up mailboxes on it themselves. Creates
 * the Mailgun domain and returns the DNS records Mailgun needs — the client
 * adds those at their own registrar/DNS host; we never touch DNS we don't
 * manage. Marks the `domains` row dns_managed_externally so provisioning
 * never tries to write to a Hostinger zone that isn't ours.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain: rawDomain } = await req.json().catch(() => ({ domain: null }));
  const domain = String(rawDomain ?? "").trim().toLowerCase();
  if (!domain || !DOMAIN_RE.test(domain)) {
    return NextResponse.json({ error: "Enter a valid domain, e.g. yourcompany.com" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("domains")
    .select("id, dns_managed_externally")
    .eq("client_id", client.id)
    .eq("domain", domain)
    .maybeSingle<{ id: string; dns_managed_externally: boolean | null }>();

  if (existing && existing.dns_managed_externally !== true) {
    return NextResponse.json({ error: `${domain} is already set up on this account` }, { status: 409 });
  }

  if (!existing) {
    const { error: insertError } = await admin
      .from("domains")
      .upsert(
        { client_id: client.id, domain, hostinger_order_id: null, dns_status: "pending", dns_managed_externally: true },
        { onConflict: "client_id,domain", ignoreDuplicates: true }
      );
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  try {
    await createMailgunDomain(domain);
    const records = await getMailgunDnsRecords(domain);
    return NextResponse.json({ ok: true, domain, records });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
