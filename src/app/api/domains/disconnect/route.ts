import { NextRequest, NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";

/**
 * P2 FIX (Existing-Domain Feature Audit, 2026-10-09): disconnect/reconnect
 * was entirely missing for either domain path.
 *
 * "Disconnect" is a SOFT disable, not a delete:
 *   - `domains.dns_status` flips to "disconnected" — mailboxes on it stop
 *     reporting "ready" (getMailboxReadiness checks Mailgun's own state, so
 *     this alone doesn't stop Mailgun sending; the real stop is removing the
 *     client's ability to re-trigger provisioning while disconnected — see
 *     below) and outreach treats the domain as unusable.
 *   - The `domains` row, every mailbox, every lead/outreach/history row tied
 *     to it is left untouched — "prevent accidental data loss" per the fix
 *     requirements.
 *   - `domain_ownership` is deliberately NEVER deleted here. Releasing
 *     ownership on disconnect would reopen exactly the P0 hijack window this
 *     whole fix closes (another client could immediately claim the same
 *     domain string the moment it's disconnected). The same client can
 *     always reconnect later without repeating the DNS TXT challenge.
 *
 * "Reconnect" flips the domain back to "pending" and re-runs the normal
 * provisioning check — ownership is re-asserted by ensureDomainProvisioned's
 * own gate (still requires THIS client to be the verified owner), so this
 * can never be used to reactivate a domain for the wrong tenant.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  const publicOrigin = resolveAppOrigin(req);
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain: rawDomain, action } = await req.json().catch(() => ({ domain: null, action: null }));
  const domain = String(rawDomain ?? "").trim().toLowerCase();
  if (!domain) return NextResponse.json({ error: "domain is required" }, { status: 400 });
  if (action !== "disconnect" && action !== "reconnect") {
    return NextResponse.json({ error: "action must be 'disconnect' or 'reconnect'" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Row-level tenant scoping is sufficient here (unlike provisioning, this
  // only ever touches THIS client's own `domains` row) — but still requires
  // the row to exist for this client, so one tenant can never disconnect or
  // reconnect a domain row that isn't theirs.
  const { data: domainRow } = await admin
    .from("domains")
    .select("id, dns_status")
    .eq("client_id", client.id)
    .eq("domain", domain)
    .maybeSingle<{ id: string; dns_status: string }>();

  if (!domainRow) {
    return NextResponse.json({ error: `${domain} is not connected to this account` }, { status: 404 });
  }

  if (action === "disconnect") {
    await admin.from("domains").update({ dns_status: "disconnected" }).eq("id", domainRow.id);
    return NextResponse.json({ ok: true, domain, dns_status: "disconnected" });
  }

  // Reconnect: restore to "pending" and immediately re-run the real
  // provisioning check, which independently re-verifies ownership before
  // doing anything — never assume reconnecting is safe just because this
  // client is the one asking.
  await admin.from("domains").update({ dns_status: "pending" }).eq("id", domainRow.id);
  const result = await ensureDomainProvisioned(admin, { clientId: client.id, domain, publicOrigin, verifyAttempts: 1 });
  return NextResponse.json({ ok: true, domain, state: result.state, notes: result.notes });
}
