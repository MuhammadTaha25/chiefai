/**
 * What the receiving server told Mailgun when a delivery failed. Today only `severity` drives behaviour, so an
 * invalid address and a provider reputation block look identical. This keeps the receiver's own words (delivery-status
 * and reason) on the lead, record-only, so real data can show how to tell them apart before any rule is written.
 * Pure: no imports, no side effects.
 */
export interface BounceDetail {
  severity: string | null;
  reason: string | null;
  delivery_status: unknown;
  event_at: string | null;
}

const MAX_JSON_CHARS = 4000;

export function buildBounceDetail(eventData: Record<string, unknown>): BounceDetail {
  const ds = eventData["delivery-status"];
  let delivery_status: unknown = ds ?? null;
  if (ds !== undefined && ds !== null && JSON.stringify(ds).length > MAX_JSON_CHARS) {
    const o = (ds ?? {}) as Record<string, unknown>;
    delivery_status = { truncated: true, code: o.code ?? null, message: String(o.message ?? o.description ?? "").slice(0, 500) };
  }
  const ts = Number(eventData.timestamp);
  return {
    severity: typeof eventData.severity === "string" ? eventData.severity : null,
    reason: typeof eventData.reason === "string" ? eventData.reason.slice(0, 500) : null,
    delivery_status,
    event_at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
  };
}
