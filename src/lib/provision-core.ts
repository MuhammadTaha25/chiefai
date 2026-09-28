/**
 * Idempotent "make this registered domain able to send and receive" sequence, written against injected
 * dependencies so the ORDER and FAILURE behaviour can be unit-tested without touching Mailgun/Hostinger:
 *
 *   Mailgun domain create -> read required DNS -> write DNS to the registrar (each record read back)
 *   -> ask Mailgun to verify -> inbound route + tracking webhooks
 *
 * Every step is safe to repeat. A later step never runs on the strength of an earlier step's claimed
 * success: DNS is only verified after the registrar confirms the records, and the result state is
 * "active" only when Mailgun itself says so.
 */
export interface DnsRecordsIn {
  sending: { record_type: string; name: string; value: string }[];
  receiving: { record_type: string; value: string; priority?: string }[];
}

export interface ProvisionDeps {
  createMailgunDomain(domain: string): Promise<unknown>;
  getMailgunDnsRecords(domain: string): Promise<DnsRecordsIn>;
  writeDns(rootDomain: string, mailgunDomain: string, records: DnsRecordsIn): Promise<{ allConfirmed: boolean; failures: string[] }>;
  verifyMailgunDomain(domain: string): Promise<string | null>;
  createInboundRoute(webhookUrl: string): Promise<unknown>;
  registerTrackingWebhooks(domain: string, webhookUrl: string): Promise<unknown>;
  /** Optional: adds a p=none DMARC record if the zone has none. Non-fatal. */
  ensureDmarc?(rootDomain: string): Promise<"exists" | "added" | "failed">;
  sleep(ms: number): Promise<void>;
}

export type ProvisionState = "active" | "pending" | "dns_failed" | "error";

export interface ProvisionResult {
  state: ProvisionState;
  /** Human-safe notes for logs/UI: which non-fatal steps failed, which DNS records were not confirmed. */
  notes: string[];
}

export async function provisionDomain(
  deps: ProvisionDeps,
  input: { domain: string; publicOrigin: string; verifyAttempts?: number; verifyDelayMs?: number }
): Promise<ProvisionResult> {
  const { domain, publicOrigin } = input;
  const notes: string[] = [];
  try {
    await deps.createMailgunDomain(domain); // "already exists" is treated as success by the implementation
    const records = await deps.getMailgunDnsRecords(domain);

    const written = await deps.writeDns(domain, domain, records);
    if (!written.allConfirmed) {
      return { state: "dns_failed", notes: written.failures.map((f) => `DNS not confirmed: ${f}`) };
    }

    // A complete SPF + DKIM + DMARC set helps inbox placement; never blocks provisioning and never overwrites an existing policy.
    if (deps.ensureDmarc) {
      const dmarc = await deps.ensureDmarc(domain).catch((e: Error) => {
        notes.push(`dmarc: ${e.message.slice(0, 120)}`);
        return "failed" as const;
      });
      if (dmarc === "failed" && !notes.some((n) => n.startsWith("dmarc"))) notes.push("dmarc: record not confirmed");
    }

    // Propagation through the registrar's nameservers takes seconds to minutes; a few short retries cover the fast
    // case, the cron covers the rest.
    const attempts = input.verifyAttempts ?? 3;
    let mailgunState: string | null = null;
    for (let i = 0; i < attempts; i++) {
      mailgunState = await deps.verifyMailgunDomain(domain);
      if (mailgunState === "active") break;
      if (i < attempts - 1) await deps.sleep(input.verifyDelayMs ?? 5000);
    }

    // Replies and bounce/complaint events. Neither blocks sending, so failures are recorded, not fatal, and both
    // are attempted on EVERY run (not only when a mailbox row is first inserted), so an existing domain heals.
    await deps.createInboundRoute(`${publicOrigin}/api/webhooks/mailgun`).catch((e: Error) => {
      notes.push(`inbound route: ${e.message.slice(0, 120)}`);
    });
    await deps.registerTrackingWebhooks(domain, `${publicOrigin}/api/webhooks/mailgun/events`).catch((e: Error) => {
      notes.push(`tracking webhooks: ${e.message.slice(0, 120)}`);
    });

    return { state: mailgunState === "active" ? "active" : "pending", notes };
  } catch (err) {
    return { state: "error", notes: [(err as Error).message.slice(0, 200)] };
  }
}

/** domains.dns_status value for a provisioning outcome. */
export function dnsStatusFor(state: ProvisionState): "active" | "pending" | "provisioning_failed" {
  return state === "active" ? "active" : state === "pending" ? "pending" : "provisioning_failed";
}
