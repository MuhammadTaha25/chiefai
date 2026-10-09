import { NextRequest, NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMailgunDomain, getMailgunDnsRecords } from "@/lib/mailgun";
import { startOwnershipChallenge, checkOwnershipChallenge } from "@/lib/domain-ownership";
import { getPortfolioEntry, provisionOwnershipTxtRecord, provisionMailgunDnsRecords, ensureDmarcRecord } from "@/lib/hostinger";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";

/**
 * Registers a domain the client already owns elsewhere (not bought through
 * us via Hostinger) so they can set up mailboxes on it themselves.
 *
 * P0 SECURITY FIX (Existing-Domain Feature Audit, 2026-10-09): this used to
 * insert a `domains` row and hand back Mailgun's DNS records with NO proof
 * the caller actually controls the domain. Because Mailgun is one shared
 * account across every tenant, a second client could type in a domain the
 * FIRST client already legitimately owns and verified, and ride on Mailgun's
 * already-"active" state — a real, reachable cross-tenant domain hijack.
 *
 * Now: startOwnershipChallenge() is the first, independent check — it
 * rejects outright (generic, non-sensitive error) if `domain_ownership`
 * already assigns this domain to a DIFFERENT client, and otherwise returns a
 * client-specific DNS TXT challenge the caller must prove before anything
 * downstream (mailbox creation, sending) is allowed to treat this domain as
 * theirs — see ensureDomainProvisioned and /api/domains/mailboxes.
 *
 * Mailgun's own SPF/DKIM/MX records are still fetched here (the client needs
 * them to actually configure sending/receiving), but — critically — Mailgun
 * reporting the domain "active" is never, by itself, treated as ownership
 * proof. Marks the `domains` row dns_managed_externally so provisioning
 * never tries to write to a Hostinger zone that isn't ours.
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
    return NextResponse.json({ error: "Enter a valid domain, e.g. yourcompany.com" }, { status: 400 });
  }

  const admin = createAdminClient();

  const challenge = await startOwnershipChallenge(admin, client.id, domain);
  if (!challenge.ok) {
    // Generic message by design — never reveal that a specific other account
    // holds the domain.
    return NextResponse.json({ error: challenge.error }, { status: 409 });
  }

  const normalizedDomain = challenge.domain;

  const { data: existing } = await admin
    .from("domains")
    .select("id")
    .eq("client_id", client.id)
    .eq("domain", normalizedDomain)
    .maybeSingle<{ id: string }>();

  if (!existing) {
    const { error: insertError } = await admin
      .from("domains")
      .upsert(
        { client_id: client.id, domain: normalizedDomain, hostinger_order_id: null, dns_status: "pending", dns_managed_externally: true },
        { onConflict: "client_id,domain", ignoreDuplicates: true }
      );
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  try {
    await createMailgunDomain(normalizedDomain);
    const records = await getMailgunDnsRecords(normalizedDomain);

    const ownership = challenge.alreadyOwned
      ? ({ owned: true as const })
      : ({ owned: false as const, hostname: challenge.hostname, token: challenge.token, expiresAt: challenge.expiresAtISO });

    // If this exact domain already sits in OUR connected Hostinger account's
    // portfolio, we genuinely control its DNS zone — write every record
    // ourselves instead of making the client copy records into a DNS panel
    // they don't actually need to touch. Any other domain (a different
    // registrar, or someone else's Hostinger account) still gets the
    // show-the-records-and-wait flow; we only ever write DNS we can prove
    // via the API we actually own.
    const portfolioEntry = await getPortfolioEntry(normalizedDomain).catch(() => null);
    if (!portfolioEntry) {
      return NextResponse.json({ ok: true, domain: normalizedDomain, records, ownership, autoProvisioned: false });
    }

    if (!challenge.alreadyOwned && challenge.hostname && challenge.token) {
      await provisionOwnershipTxtRecord(normalizedDomain, challenge.hostname, challenge.token);
    }
    const mailgunWrite = await provisionMailgunDnsRecords(normalizedDomain, normalizedDomain, records);
    await ensureDmarcRecord(normalizedDomain).catch(() => "failed" as const);

    // Re-check ownership now that we just wrote the TXT record ourselves,
    // then fall through to the same Mailgun/SPF/DKIM/MX verification every
    // other domain path uses — never assume our own write succeeded just
    // because the API call didn't throw (see addZoneRecordAndVerify).
    const ownershipCheck = await checkOwnershipChallenge(admin, client.id, normalizedDomain);
    let verifyState: string | null = null;
    if (ownershipCheck.ok) {
      const result = await ensureDomainProvisioned(admin, { clientId: client.id, domain: normalizedDomain, publicOrigin, verifyAttempts: 1 });
      verifyState = result.state;
    }

    return NextResponse.json({
      ok: true,
      domain: normalizedDomain,
      records,
      ownership: ownershipCheck.ok ? { owned: true as const } : ownership,
      autoProvisioned: true,
      autoProvisionedAllConfirmed: mailgunWrite.allConfirmed,
      verifyState,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
