import { NextRequest, NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";
import { checkOwnershipChallenge } from "@/lib/domain-ownership";

/**
 * Re-checks an externally-DNS-managed domain. Two independent things must
 * both pass, in order:
 *
 *   1. OWNERSHIP — checkOwnershipChallenge() does its own DNS TXT lookup
 *      against the client-specific `_infomist-verify-<token>.<domain>`
 *      hostname (see domain-ownership-core.ts). This is the P0 fix: it is
 *      checked independently of anything Mailgun reports, and gates
 *      everything that follows.
 *   2. MAILGUN/DNS — only once ownership is confirmed does this fall through
 *      to ensureDomainProvisioned(), the same SPF/DKIM/MX verification every
 *      other domain path uses. Ground truth there is still Mailgun's own
 *      verified state — this never writes DNS ourselves for a zone we
 *      don't control.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  const publicOrigin = resolveAppOrigin(req);
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain: rawDomain } = await req.json().catch(() => ({ domain: null }));
  const domain = String(rawDomain ?? "").trim();
  if (!domain) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const ownership = await checkOwnershipChallenge(admin, client.id, domain);
  if (!ownership.ok) {
    const message: Record<string, string> = {
      owned_by_other: "This domain is already connected to a different account.",
      invalid_domain: "Enter a valid domain, e.g. yourcompany.com",
      no_challenge: "Start by entering this domain above first.",
      expired: "This verification request expired. Enter the domain again to get a new one.",
      dns_not_found: "Verification TXT record not found yet. DNS may still be propagating.",
      dns_mismatch: "Verification TXT record found, but its value doesn't match. Double check what you added.",
    };
    return NextResponse.json({ ok: true, state: `ownership_${ownership.state}`, error: message[ownership.state] ?? "Ownership verification failed" });
  }

  const { data: domainRow } = await admin
    .from("domains")
    .select("id, dns_managed_externally")
    .eq("client_id", client.id)
    .eq("domain", ownership.domain)
    .maybeSingle<{ id: string; dns_managed_externally: boolean | null }>();

  if (!domainRow || domainRow.dns_managed_externally !== true) {
    return NextResponse.json({ error: `${ownership.domain} isn't set up as a client-managed domain` }, { status: 404 });
  }

  const result = await ensureDomainProvisioned(admin, { clientId: client.id, domain: ownership.domain, publicOrigin, verifyAttempts: 1 });
  return NextResponse.json({ ok: true, state: result.state, notes: result.notes });
}
