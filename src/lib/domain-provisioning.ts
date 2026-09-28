import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createMailgunDomain,
  getMailgunDnsRecords,
  verifyMailgunDomain,
  createInboundRoute,
  registerTrackingWebhooks,
} from "@/lib/mailgun";
import { provisionMailgunDnsRecords, ensureDmarcRecord } from "@/lib/hostinger";
import { provisionDomain, dnsStatusFor, type ProvisionResult } from "@/lib/provision-core";

/**
 * The one place that turns a REGISTERED domain into a send-and-receive-ready Mailgun domain, and records the
 * outcome on domains.dns_status. Used by the post-purchase flow, the "add mailbox" route and the provisioning
 * cron, so all three behave identically and any of them can repair a domain another one left half-done.
 */
export async function ensureDomainProvisioned(
  admin: SupabaseClient,
  params: { clientId: string; domain: string; publicOrigin: string; verifyAttempts?: number }
): Promise<ProvisionResult> {
  const result = await provisionDomain(
    {
      createMailgunDomain,
      getMailgunDnsRecords,
      writeDns: provisionMailgunDnsRecords,
      ensureDmarc: ensureDmarcRecord,
      verifyMailgunDomain,
      createInboundRoute: (url) => createInboundRoute("", url),
      registerTrackingWebhooks,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { domain: params.domain, publicOrigin: params.publicOrigin, verifyAttempts: params.verifyAttempts }
  );

  await admin
    .from("domains")
    .update({ dns_status: dnsStatusFor(result.state) })
    .eq("client_id", params.clientId)
    .eq("domain", params.domain);

  if (result.state !== "active") {
    // eslint-disable-next-line no-console
    console.error(`[provision] domain=${params.domain} client=${params.clientId} state=${result.state} ${result.notes.join("; ")}`);
  }
  return result;
}
