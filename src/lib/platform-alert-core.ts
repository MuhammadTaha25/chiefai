/** Pure: turns the daily health result into an alert mail, or null when everything is fine. */
export interface HealthSummary {
  sendingBroken: number;
  errors: number;
  platform?: {
    duplicateMailboxes: { address: string; clients: number; rows: number }[];
    inboundRoute: { ok: boolean; problem?: string };
    needsAttention: boolean;
  };
}

export function buildPlatformAlert(h: HealthSummary): { subject: string; text: string } | null {
  const lines: string[] = [];
  if (h.sendingBroken > 0) lines.push(`${h.sendingBroken} domain(s) cannot send (DNS records broken). Open the Domains page.`);
  if (h.errors > 0) lines.push(`${h.errors} domain check(s) failed to run.`);
  const p = h.platform;
  if (p) {
    for (const d of p.duplicateMailboxes) lines.push(`Mailbox ${d.address} exists ${d.rows} times (${d.clients} clients): replies can go to the wrong client.`);
    if (!p.inboundRoute.ok) lines.push(`Mailgun inbound route problem: ${p.inboundRoute.problem ?? "unknown"}. Replies and STOP requests may not arrive.`);
  }
  if (lines.length === 0) return null;
  return { subject: "ChiefAI needs attention", text: ["Daily health check found:", "", ...lines.map((l) => `- ${l}`), "", "- ChiefAI"].join("\n") };
}
