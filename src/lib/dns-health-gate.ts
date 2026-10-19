import type { SupabaseClient } from "@supabase/supabase-js";
import type { DnsHealth } from "@/lib/dns-health-core";

/**
 * Domains whose last stored check says SPF/DKIM is broken. Only consulted when DNS_HEALTH_PAUSE_SENDING=1
 * (off by default), so a wrong check can never stop real mail until that is switched on deliberately.
 */
export async function getSendingBrokenDomains(admin: SupabaseClient, clientId: string): Promise<Set<string>> {
  if (process.env.DNS_HEALTH_PAUSE_SENDING !== "1") return new Set();
  const { data } = await admin.from("domains").select("domain, dns_health").eq("client_id", clientId).returns<{ domain: string; dns_health: DnsHealth | null }[]>();
  return new Set((data ?? []).filter((d) => d.dns_health && d.dns_health.sendingOk === false).map((d) => d.domain.toLowerCase()));
}
