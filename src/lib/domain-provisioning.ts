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
  // A domain the client brought themselves (DNS hosted at their own
  // registrar, not in our Hostinger account) can never be written to via
  // Hostinger's zone API — that call would just 404 against a zone that
  // isn't ours. Skip the write/DMARC steps for it; Mailgun's own verify is
  // ground truth either way, so this never reports "active" on records that
  // were never actually added.
  const { data: domainRow } = await admin
    .from("domains")
    .select("dns_managed_externally")
    .eq("client_id", params.clientId)
    .eq("domain", params.domain)
    .maybeSingle<{ dns_managed_externally: boolean | null }>();
  const external = domainRow?.dns_managed_externally === true;

  const result = await provisionDomain(
    {
      createMailgunDomain,
      getMailgunDnsRecords,
      writeDns: external ? async () => ({ allConfirmed: true, failures: [] }) : provisionMailgunDnsRecords,
      ensureDmarc: external ? undefined : ensureDmarcRecord,
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
