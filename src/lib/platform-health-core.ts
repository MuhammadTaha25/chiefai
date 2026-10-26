/**
 * Platform-level checks that sit outside any one domain's DNS: both were the cause of a real outage in the 20 Oct live test.
 * Pure on purpose (no imports) so they run without the app's path aliases.
 */

/** Mailbox addresses stored more than once (same client or across clients). A duplicate makes inbound replies "ambiguous", so they are ignored. */
export function findDuplicateMailboxes(rows: { address: string; client_id: string }[]): { address: string; clients: number; rows: number }[] {
  const byAddress = new Map<string, { rows: number; clients: Set<string> }>();
  for (const r of rows) {
    const key = r.address.trim().toLowerCase();
    const e = byAddress.get(key) ?? { rows: 0, clients: new Set<string>() };
    e.rows += 1;
    e.clients.add(r.client_id);
    byAddress.set(key, e);
  }
  return [...byAddress.entries()].filter(([, e]) => e.rows > 1).map(([address, e]) => ({ address, clients: e.clients.size, rows: e.rows }));
}

export interface InboundRoute {
  expression: string;
  actions: string[];
}

export type InboundRouteStatus =
  | { ok: true; staleCatchAlls: number }
  | { ok: false; problem: "no_catch_all" | "wrong_url"; catchAlls: number };

/**
 * Inbound replies arrive through one Mailgun catch-all route that must forward to this app's webhook. A route pointing at an old URL
 * (e.g. a dead tunnel) silently loses every reply.
 */
export function inboundRouteStatus(routes: InboundRoute[], webhookUrl: string): InboundRouteStatus {
  const catchAlls = routes.filter((r) => r.expression.includes("catch_all"));
  if (catchAlls.length === 0) return { ok: false, problem: "no_catch_all", catchAlls: 0 };
  const pointedHere = catchAlls.filter((r) => r.actions.some((a) => a.includes(webhookUrl)));
  if (pointedHere.length === 0) return { ok: false, problem: "wrong_url", catchAlls: catchAlls.length };
  return { ok: true, staleCatchAlls: catchAlls.length - pointedHere.length };
}
