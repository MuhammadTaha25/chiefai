/**
 * Server-only. Real-world wiring for domain-ownership-core.ts: a real
 * Supabase admin client and Node's own DNS resolver (independent of
 * Mailgun — this must never ask Mailgun whether a domain is "owned", only
 * whether DNS itself carries the exact challenge token).
 */
import crypto from "crypto";
import dns from "dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  startOwnershipChallenge as startOwnershipChallengeCore,
  checkOwnershipChallenge as checkOwnershipChallengeCore,
  evaluateDomainUsable,
  normalizeDomain,
  type OwnershipDeps,
  type OwnershipRow,
} from "@/lib/domain-ownership-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function realDeps(admin: Admin): OwnershipDeps {
  return {
    async getOwnershipRow(domain) {
      const { data } = await admin.from("domain_ownership").select("client_id").eq("domain", domain).maybeSingle<OwnershipRow>();
      return data ?? null;
    },
    async getChallenge(clientId, domain) {
      const { data } = await admin
        .from("domain_ownership_challenges")
        .select("token, status, expires_at")
        .eq("client_id", clientId)
        .eq("domain", domain)
        .maybeSingle<{ token: string; status: "pending" | "verified" | "expired"; expires_at: string }>();
      return data ?? null;
    },
    async upsertChallenge(clientId, domain, token, expiresAtISO) {
      await admin
        .from("domain_ownership_challenges")
        .upsert(
          { client_id: clientId, domain, token, status: "pending", expires_at: expiresAtISO, verified_at: null },
          { onConflict: "client_id,domain" }
        );
    },
    async claimOwnership(domain, clientId, via) {
      // The atomic DB-level guarantee: ON CONFLICT (domain) DO NOTHING means
      // only the first caller for a given domain can ever insert. Everyone
      // else's insert is a no-op, and the follow-up select reports who
      // actually won — this cannot be raced the way an app-level
      // SELECT-then-INSERT check could be.
      await admin.from("domain_ownership").upsert(
        { domain, client_id: clientId, verified_via: via, verified_at: new Date().toISOString() },
        { onConflict: "domain", ignoreDuplicates: true }
      );
      const { data } = await admin.from("domain_ownership").select("client_id").eq("domain", domain).maybeSingle<OwnershipRow>();
      return { claimed: data?.client_id === clientId, ownerClientId: data?.client_id ?? clientId };
    },
    async markChallengeVerified(clientId, domain) {
      await admin
        .from("domain_ownership_challenges")
        .update({ status: "verified", verified_at: new Date().toISOString() })
        .eq("client_id", clientId)
        .eq("domain", domain);
    },
    resolveTxt(hostname) {
      return new Promise((resolve, reject) => {
        dns.resolveTxt(hostname, (err, records) => (err ? reject(err) : resolve(records)));
      });
    },
    now: () => new Date(),
    randomToken: () => crypto.randomBytes(20).toString("hex"),
  };
}

export async function startOwnershipChallenge(admin: Admin, clientId: string, domain: string) {
  return startOwnershipChallengeCore(realDeps(admin), clientId, domain);
}

export async function checkOwnershipChallenge(admin: Admin, clientId: string, domain: string) {
  return checkOwnershipChallengeCore(realDeps(admin), clientId, domain);
}

/**
 * The gate every downstream action (mailbox creation, provisioning,
 * sending) must call before trusting a domain is this client's to use.
 * `requireExplicitOwnership: true` for domains that only ever get a
 * `domain_ownership` row via a passed challenge (dns_managed_externally);
 * `false` (the default) for domains that predate this fix, so existing
 * purchased-domain customers are never retroactively locked out.
 */
export async function assertDomainUsableByClient(
  admin: Admin,
  clientId: string,
  domainInput: string,
  opts: { requireExplicitOwnership?: boolean } = {}
): Promise<{ usable: true } | { usable: false; reason: "owned_by_other" | "ownership_not_verified" | "invalid_domain" }> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return { usable: false, reason: "invalid_domain" };
  const { data: owner } = await admin.from("domain_ownership").select("client_id").eq("domain", domain).maybeSingle<OwnershipRow>();
  return evaluateDomainUsable(owner ?? null, clientId, Boolean(opts.requireExplicitOwnership));
}

/**
 * Has this client explicitly disconnected this domain (see
 * /api/domains/disconnect)? Checked alongside ownership on every send path —
 * a disconnected domain's mailboxes can still read "ready" from Mailgun's
 * own state (disconnecting never un-verifies the Mailgun domain itself), so
 * this DB-level flag is what actually stops outreach from using it.
 */
export async function isDomainDisconnected(admin: Admin, clientId: string, domain: string): Promise<boolean> {
  const { data } = await admin.from("domains").select("dns_status").eq("client_id", clientId).eq("domain", domain).maybeSingle<{ dns_status: string }>();
  return data?.dns_status === "disconnected";
}

/** Normalized domains this client has marked as externally-DNS-managed — used to decide whether assertDomainUsableByClient should require an explicit ownership row for a given mailbox's domain. */
export async function getExternalDomainsForClient(admin: Admin, clientId: string): Promise<Set<string>> {
  const { data } = await admin.from("domains").select("domain").eq("client_id", clientId).eq("dns_managed_externally", true).returns<{ domain: string }[]>();
  return new Set((data ?? []).map((d) => d.domain.toLowerCase()));
}

/**
 * Best-effort auto-claim for a domain just registered through Hostinger —
 * real proof of control (we just paid the registrar for it), so this never
 * blocks the purchase flow on a DB race. If the domain string is already
 * verified-owned by a DIFFERENT client (a rare, real pre-existing dispute —
 * e.g. the same string was independently DNS-verified by someone else
 * through the external-domain path), this logs loudly and does NOT
 * overwrite the existing row; it never force-reassigns ownership.
 */
export async function claimPurchasedDomainOwnership(admin: Admin, clientId: string, domain: string): Promise<void> {
  const normalized = normalizeDomain(domain);
  if (!normalized) return;
  try {
    await admin
      .from("domain_ownership")
      .upsert({ domain: normalized, client_id: clientId, verified_via: "hostinger_purchase", verified_at: new Date().toISOString() }, { onConflict: "domain", ignoreDuplicates: true });
    const { data } = await admin.from("domain_ownership").select("client_id").eq("domain", normalized).maybeSingle<OwnershipRow>();
    if (data && data.client_id !== clientId) {
      // eslint-disable-next-line no-console
      console.error(
        `[domain-ownership] CONFLICT: client ${clientId} purchased ${normalized} via Hostinger, but domain_ownership already assigns it to client ${data.client_id}. Needs manual review — not auto-resolved.`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[domain-ownership] claimPurchasedDomainOwnership failed for ${normalized}:`, (err as Error).message);
  }
}
