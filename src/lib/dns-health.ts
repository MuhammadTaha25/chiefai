import { promises as dns } from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMailgunDnsRecords } from "@/lib/mailgun";
import { checkDomainDns, type DnsHealth, type DnsResolver } from "@/lib/dns-health-core";

export const nodeResolver: DnsResolver = {
  resolveTxt: (n) => dns.resolveTxt(n),
  resolveMx: (n) => dns.resolveMx(n),
  resolveCname: (n) => dns.resolveCname(n),
};

/** Checks one domain against what Mailgun requires. Read-only against DNS and Mailgun. */
export async function checkDomain(domain: string): Promise<DnsHealth> {
  const expected = await getMailgunDnsRecords(domain);
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
    } catch {
      out.errors++; // Mailgun/DNS hiccup: keep the previous stored result rather than overwrite it with a guess
    }
  }
  return out;
}
