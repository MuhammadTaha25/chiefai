import { NextRequest, NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";

/**
 * Re-checks an externally-DNS-managed domain against whatever the client has
 * actually added at their own registrar — never writes DNS ourselves for it.
 * Ground truth is Mailgun's own verified state, same as every other
 * provisioning path in the app.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  const publicOrigin = resolveAppOrigin(req);
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain: rawDomain } = await req.json().catch(() => ({ domain: null }));
  const domain = String(rawDomain ?? "").trim().toLowerCase();
  if (!domain) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: domainRow } = await admin
    .from("domains")
    .select("id, dns_managed_externally")
    .eq("client_id", client.id)
    .eq("domain", domain)
    .maybeSingle<{ id: string; dns_managed_externally: boolean | null }>();

  if (!domainRow || domainRow.dns_managed_externally !== true) {
    return NextResponse.json({ error: `${domain} isn't set up as a client-managed domain` }, { status: 404 });
  }

  const result = await ensureDomainProvisioned(admin, { clientId: client.id, domain, publicOrigin, verifyAttempts: 1 });
  return NextResponse.json({ ok: true, state: result.state, notes: result.notes });
}
