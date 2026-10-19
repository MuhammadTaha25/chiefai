import { promises as dns } from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMailgunDnsRecords } from "@/lib/mailgun";
import { checkDomainDns, isMailgunDomainNotFound, notInMailgunHealth, type DnsHealth, type DnsResolver } from "@/lib/dns-health-core";

// Always ask well-known public resolvers (not whatever the host machine is configured with): the result is then the
// same on every machine, and a router/ISP DNS that refuses c-ares connections (ECONNREFUSED) cannot break the check.
const publicDns = new dns.Resolver({ timeout: 4000, tries: 2 });
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);

export const nodeResolver: DnsResolver = {
  resolveTxt: (n) => publicDns.resolveTxt(n),
  resolveMx: (n) => publicDns.resolveMx(n),
  resolveCname: (n) => publicDns.resolveCname(n),
};

/** Checks one domain against what Mailgun requires. Read-only against DNS and Mailgun. */
export async function checkDomain(domain: string): Promise<DnsHealth> {
  let expected;
  try {
    expected = await getMailgunDnsRecords(domain);
  } catch (e) {
    if (isMailgunDomainNotFound(e)) return notInMailgunHealth(domain);
    throw e;
  }
  return checkDomainDns(domain, expected, nodeResolver);
}

/** Checks every active domain (optionally one client's) and stores the result. Returns counts for the cron response. */
export async function runDnsHealth(admin: SupabaseClient, clientId?: string) {
  let q = admin.from("domains").select("id, domain").eq("dns_status", "active");
  if (clientId) q = q.eq("client_id", clientId);
  const { data: rows } = await q.returns<{ id: string; domain: string }[]>();
  const out = { checked: 0, healthy: 0, sendingBroken: 0, errors: 0 };
  for (const row of rows ?? []) {
    try {
      const health = await checkDomain(row.domain);
      await admin.from("domains").update({ dns_health: health, dns_checked_at: new Date().toISOString() }).eq("id", row.id);
      out.checked++;
      if (health.allOk) out.healthy++;
      if (!health.sendingOk) out.sendingBroken++;
    } catch (e) {
      console.error(`[dns-health] ${row.domain}: ${(e as { code?: string }).code ?? (e as Error).message}`);
      out.errors++; // Mailgun/DNS hiccup: keep the previous stored result rather than overwrite it with a guess
    }
  }
  return out;
}
