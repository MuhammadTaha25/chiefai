/**
 * Structured, secret-safe business-event log (one JSON line per event, so it is
 * greppable in Vercel/server logs). No external provider on purpose.
 * Only identifiers and outcomes belong here — never tokens, keys, signing
 * secrets or message bodies. Any field whose name looks sensitive is dropped.
 */
const SENSITIVE = /token|secret|key|password|authorization|signature|cookie|body|text|payload/i;

// Even a harmless-looking field (e.g. an error message) must not carry a credential.
const SECRET_VALUE = /(sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|key-[0-9a-f]{20,}|Bearer\s+[A-Za-z0-9._-]+)/g;

export function logEvent(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  const safe: Record<string, unknown> = { event, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || SENSITIVE.test(k)) continue;
    safe[k] = typeof v === "string" ? v.replace(SECRET_VALUE, "[redacted]").slice(0, 200) : v;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(safe));
}
