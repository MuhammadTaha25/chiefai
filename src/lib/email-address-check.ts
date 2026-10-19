import { promises as dns } from "node:dns";

/**
 * Pre-send check on a lead's address, so we never spend a send (and a bounce on our reputation) on an address that
 * cannot receive mail. Three tiers: syntax, throwaway/disposable domains, and "does the domain accept mail at all"
 * (MX, falling back to A/AAAA per RFC 5321). A lookup that FAILS (timeout, refused) is "unknown" and lets the send
 * proceed: only a definite "this domain does not exist / has no mail server" blocks.
 */
export type AddressCheck = { ok: true } | { ok: false; reason: "syntax" | "disposable" | "no_mail_server" };

export interface MxResolver {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

const publicDns = new dns.Resolver({ timeout: 3000, tries: 2 });
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);
export const defaultMxResolver: MxResolver = {
  resolveMx: (n) => publicDns.resolveMx(n),
  resolve4: (n) => publicDns.resolve4(n),
  resolve6: (n) => publicDns.resolve6(n),
};

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
// Reserved TLDs never resolve (used by tests and examples); not a real-world prospect.
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
  "trashmail.com", "sharklasers.com", "getnada.com", "throwawaymail.com", "dispostable.com", "maildrop.cc",
]);
const NOT_PUBLISHED = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

async function answer<T>(p: Promise<T[]>): Promise<{ definite: boolean; rows: T[] }> {
  try {
    return { definite: true, rows: await p };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { definite: Boolean(code && NOT_PUBLISHED.has(code)), rows: [] };
  }
}

export async function checkEmailAddress(email: string, resolver: MxResolver = defaultMxResolver): Promise<AddressCheck> {
  const m = EMAIL_RE.exec(email.trim());
  if (!m) return { ok: false, reason: "syntax" };
  const domain = m[1].toLowerCase();
  if (DISPOSABLE.has(domain)) return { ok: false, reason: "disposable" };
  if (RESERVED_TLDS.has(domain.split(".").pop()!)) return { ok: true };

  const mx = await answer(resolver.resolveMx(domain));
  if (mx.rows.length > 0) return { ok: true };
  if (!mx.definite) return { ok: true }; // lookup failed: unknown, do not block
  const [a, aaaa] = await Promise.all([answer(resolver.resolve4(domain)), answer(resolver.resolve6(domain))]);
  if (a.rows.length > 0 || aaaa.rows.length > 0) return { ok: true }; // implicit MX
  if (!a.definite || !aaaa.definite) return { ok: true };
  return { ok: false, reason: "no_mail_server" };
}
