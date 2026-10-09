/**
 * Pure ownership-challenge logic, written against injected dependencies
 * (same pattern as provision-core.ts) so the security-critical decisions —
 * who owns a domain, whether a challenge passed, whether a concurrent claim
 * wins — can be unit-tested without a real Supabase project or real DNS.
 *
 * P0 fix (Existing-Domain Feature Audit, 2026-10-09): a domain string in
 * `domains` was only unique per (client_id, domain), so two different
 * clients could each register the SAME domain and both ride on Mailgun's
 * one shared "active" state with zero proof either of them actually
 * controls it. This module is the independent ownership gate that must pass
 * BEFORE Mailgun's state is trusted for anything.
 */

export interface OwnershipRow {
  client_id: string;
}

export interface ChallengeRow {
  token: string;
  status: "pending" | "verified" | "expired";
  expires_at: string; // ISO
}

export interface OwnershipDeps {
  /** domain_ownership row for this exact normalized domain, or null. */
  getOwnershipRow(domain: string): Promise<OwnershipRow | null>;
  /** domain_ownership_challenges row for (clientId, domain), or null. */
  getChallenge(clientId: string, domain: string): Promise<ChallengeRow | null>;
  /** Upsert on the (client_id, domain) unique constraint — regenerates the token. */
  upsertChallenge(clientId: string, domain: string, token: string, expiresAtISO: string): Promise<void>;
  /**
   * Atomic claim: insert into domain_ownership with ON CONFLICT (domain) DO
   * NOTHING, then report who actually ended up owning it. This is the
   * DB-enforced guarantee — two concurrent callers racing this can never
   * both end up `claimed: true`.
   */
  claimOwnership(domain: string, clientId: string, via: "dns_txt_challenge" | "hostinger_purchase"): Promise<{ claimed: boolean; ownerClientId: string }>;
  markChallengeVerified(clientId: string, domain: string): Promise<void>;
  /** dns.promises.resolveTxt's own return shape: array of TXT record chunk-arrays. */
  resolveTxt(hostname: string): Promise<string[][]>;
  now(): Date;
  randomToken(): string;
}

export const CHALLENGE_TTL_MS = 48 * 60 * 60 * 1000;

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/;

/** Lowercase, strip a trailing dot, validate shape. Returns null for anything that isn't a plausible domain. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.+$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

/** The unique verification hostname a client must add a TXT record at. */
export function verificationHostname(domain: string, token: string): string {
  return `_infomist-verify-${token}.${domain}`;
}

export type StartChallengeResult =
  | { ok: true; domain: string; alreadyOwned: true }
  | { ok: true; domain: string; alreadyOwned: false; token: string; hostname: string; expiresAtISO: string }
  | { ok: false; error: string };

/**
 * Begins (or returns the still-valid existing) ownership challenge for this
 * client+domain. Rejects immediately, with a generic non-sensitive message,
 * if a DIFFERENT client already owns this domain — this is the first line
 * of defense; checkOwnershipChallenge's atomic claimOwnership call is the
 * one that actually can't be raced.
 */
export async function startOwnershipChallenge(deps: OwnershipDeps, clientId: string, domainInput: string): Promise<StartChallengeResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return { ok: false, error: "Enter a valid domain, e.g. yourcompany.com" };

  const owner = await deps.getOwnershipRow(domain);
  if (owner) {
    if (owner.client_id !== clientId) {
      return { ok: false, error: "This domain is already connected to a different account." };
    }
    return { ok: true, domain, alreadyOwned: true };
  }

  const now = deps.now();
  const existing = await deps.getChallenge(clientId, domain);
  if (existing && existing.status === "pending" && new Date(existing.expires_at) > now) {
    return { ok: true, domain, alreadyOwned: false, token: existing.token, hostname: verificationHostname(domain, existing.token), expiresAtISO: existing.expires_at };
  }

  const token = deps.randomToken();
  const expiresAtISO = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  await deps.upsertChallenge(clientId, domain, token, expiresAtISO);
  return { ok: true, domain, alreadyOwned: false, token, hostname: verificationHostname(domain, token), expiresAtISO };
}

export type CheckChallengeResult =
  | { ok: true; state: "owned"; domain: string }
  | { ok: false; state: "owned_by_other" | "invalid_domain" | "no_challenge" | "expired" | "dns_not_found" | "dns_mismatch"; domain: string };

/**
 * Independently verifies the DNS TXT challenge (never trusts Mailgun's
 * domain state as proof of ownership), then atomically claims
 * `domain_ownership` on success. The atomic claim is re-checked even after a
 * passing DNS lookup, because two clients could both pass their own DNS
 * check in the same window (e.g. one client's challenge host happens to
 * collide, or a slow TOCTOU race) — the DB insert is the only step that
 * cannot be won by more than one caller.
 */
export async function checkOwnershipChallenge(deps: OwnershipDeps, clientId: string, domainInput: string): Promise<CheckChallengeResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return { ok: false, state: "invalid_domain", domain: domainInput };

  const owner = await deps.getOwnershipRow(domain);
  if (owner) {
    return owner.client_id === clientId ? { ok: true, state: "owned", domain } : { ok: false, state: "owned_by_other", domain };
  }

  const challenge = await deps.getChallenge(clientId, domain);
  if (!challenge) return { ok: false, state: "no_challenge", domain };
  if (deps.now() > new Date(challenge.expires_at)) return { ok: false, state: "expired", domain };

  const hostname = verificationHostname(domain, challenge.token);
  let records: string[][];
  try {
    records = await deps.resolveTxt(hostname);
  } catch {
    return { ok: false, state: "dns_not_found", domain };
  }
  const flat = records.map((chunks) => chunks.join("").trim());
  if (!flat.includes(challenge.token)) {
    return { ok: false, state: "dns_mismatch", domain };
  }

  const claim = await deps.claimOwnership(domain, clientId, "dns_txt_challenge");
  if (!claim.claimed) {
    // Someone else's claim landed first in the race window — the DB, not
    // this check, is the final word.
    return claim.ownerClientId === clientId ? { ok: true, state: "owned", domain } : { ok: false, state: "owned_by_other", domain };
  }
  await deps.markChallengeVerified(clientId, domain);
  return { ok: true, state: "owned", domain };
}

/**
 * Gate for every downstream action (mailbox creation, provisioning,
 * sending). `requireExplicitOwnership: true` means "no ownership row at all"
 * is ALSO a block — used for domains going through the new external-domain
 * flow, where a row only appears after a passed challenge, so its absence
 * means the challenge was never completed. `false` is the legacy-safe
 * default for domains that predate this fix (e.g. a purchased domain from
 * before this migration shipped) — preserving existing functionality for
 * domains nobody was ever required to prove ownership of.
 */
export type DomainUsableResult = { usable: true } | { usable: false; reason: "owned_by_other" | "ownership_not_verified" };

export function evaluateDomainUsable(owner: OwnershipRow | null, clientId: string, requireExplicitOwnership: boolean): DomainUsableResult {
  if (owner) {
    return owner.client_id === clientId ? { usable: true } : { usable: false, reason: "owned_by_other" };
  }
  return requireExplicitOwnership ? { usable: false, reason: "ownership_not_verified" } : { usable: true };
}
