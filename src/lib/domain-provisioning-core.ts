/**
 * Pure pre-flight gate for ensureDomainProvisioned (domain-provisioning.ts),
 * extracted so the two Final Regression Audit (2026-10-09) fixes — the
 * disconnect-bypass and the ownership gate's exact notes/outcomes — are
 * independently unit-testable without a real Supabase client.
 */
export type ProvisioningGateResult =
  | { proceed: true }
  | { proceed: false; notes: string[] };

export type UsabilityInput = { usable: true } | { usable: false; reason: "owned_by_other" | "ownership_not_verified" | "invalid_domain" };

/**
 * REGRESSION FIX: a disconnected domain must never be silently re-enabled by
 * any caller of ensureDomainProvisioned (mailbox creation, the cron) other
 * than the dedicated reconnect flow, which clears dns_status to "pending"
 * BEFORE calling in — so this check never fires for a genuine reconnect.
 */
export function decideProvisioningGate(input: { dnsStatus: string | null | undefined; usable: UsabilityInput }): ProvisioningGateResult {
  if (input.dnsStatus === "disconnected") {
    return { proceed: false, notes: ["This domain is disconnected — reconnect it first (see /api/domains/disconnect)."] };
  }
  if (!input.usable.usable) {
    const notes =
      input.usable.reason === "owned_by_other"
        ? ["This domain is connected to a different account and cannot be provisioned here."]
        : input.usable.reason === "ownership_not_verified"
          ? ["Ownership has not been verified for this domain yet — complete the DNS TXT challenge first."]
          : ["Invalid domain."];
    return { proceed: false, notes };
  }
  return { proceed: true };
}
