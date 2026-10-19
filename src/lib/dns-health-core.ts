/**
 * Pure DNS health logic: compares what Mailgun says a domain needs (SPF, DKIM, MX, tracking CNAME) plus a DMARC
 * policy against what is actually published in DNS. The resolver is injected (same pattern as provision-core.ts) so
 * every decision is unit-testable without real DNS. Detect-and-report only: nothing here writes DNS.
 */

export type RecordStatus = "ok" | "missing" | "mismatch" | "duplicate_spf";
export type RecordKind = "spf" | "dkim" | "mx" | "cname" | "dmarc";

export interface ExpectedSending {
  record_type: string; // "TXT" | "CNAME"
  name: string;
  value: string;
}
export interface ExpectedReceiving {
  record_type: string;
  value: string;
  priority?: string;
}
export interface ExpectedRecords {
  sending: ExpectedSending[];
  receiving: ExpectedReceiving[];
}

export interface DnsResolver {
  /** dns.promises.resolveTxt shape; must resolve to [] (not throw) when the name has no record. */
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCname(name: string): Promise<string[]>;
}

export interface RecordCheck {
  kind: RecordKind;
  name: string;
  status: RecordStatus;
  expected?: string;
  found?: string[];
}

export interface DnsHealth {
  domain: string;
  /** Set when the domain could not be checked against Mailgun's requirements at all. */
  problem?: "not_in_mailgun";
  checks: RecordCheck[];
  /** SPF + DKIM are what Mailgun needs to send; MX/CNAME/DMARC are reported but do not block sending. */
  sendingOk: boolean;
  allOk: boolean;
}

const stripQuotes = (s: string) => s.trim().replace(/^"|"$/g, "");
const squash = (s: string) => stripQuotes(s).replace(/\s+/g, "").toLowerCase();
const host = (s: string) => s.trim().replace(/\.$/, "").toLowerCase();

export function relativeToFqdn(name: string, domain: string): string {
  const n = host(name);
  if (n === "@" || n === "") return host(domain);
  return n.endsWith(host(domain)) ? n : `${n}.${host(domain)}`;
}

/** "Nothing published" (NXDOMAIN/NODATA) is an answer; a timeout or refused/failed lookup is NOT, so it propagates and the caller keeps the previous result. */
const NOT_PUBLISHED = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && NOT_PUBLISHED.has(code)) return fallback;
    throw e;
  }
}

async function txtAt(r: DnsResolver, name: string): Promise<string[]> {
  const rows = await safe(r.resolveTxt(name), [] as string[][]);
  return rows.map((chunks) => chunks.join(""));
}

function spfTokens(v: string): string[] {
  return v.toLowerCase().split(/\s+/).filter((t) => t.startsWith("include:") || t.startsWith("ip4:") || t.startsWith("ip6:") || t.startsWith("a") || t === "mx");
}

export function checkSpf(found: string[], expected: string): { status: RecordStatus; found: string[] } {
  const spf = found.filter((t) => /^v=spf1(\s|$)/i.test(stripQuotes(t)));
  if (spf.length === 0) return { status: "missing", found: [] };
  if (spf.length > 1) return { status: "duplicate_spf", found: spf }; // two SPF records = permerror at the receiver
  const have = new Set(spfTokens(stripQuotes(spf[0])));
  const need = spfTokens(stripQuotes(expected)).filter((t) => t.startsWith("include:"));
  return { status: need.every((t) => have.has(t)) ? "ok" : "mismatch", found: spf };
}

export function checkDkim(found: string[], expected: string): { status: RecordStatus; found: string[] } {
  const keyOf = (v: string) => /p=([^;]+)/i.exec(squash(v))?.[1] ?? "";
  const want = keyOf(expected);
  const cands = found.filter((t) => /p=/i.test(t));
  if (cands.length === 0) return { status: "missing", found: [] };
  return { status: cands.some((t) => keyOf(t) === want) ? "ok" : "mismatch", found: cands };
}

export function checkMx(found: { exchange: string; priority: number }[], expected: ExpectedReceiving[]): { status: RecordStatus; found: string[] } {
  const have = found.map((m) => host(m.exchange));
  if (have.length === 0) return { status: "missing", found: [] };
  const need = expected.map((e) => host(e.value));
  return { status: need.every((n) => have.includes(n)) ? "ok" : "mismatch", found: have };
}

export function checkDmarc(found: string[]): { status: RecordStatus; found: string[] } {
  const d = found.filter((t) => /^v=dmarc1/i.test(stripQuotes(t)));
  return d.length ? { status: "ok", found: d } : { status: "missing", found: [] };
}

export async function checkDomainDns(domain: string, expected: ExpectedRecords, r: DnsResolver): Promise<DnsHealth> {
  const checks: RecordCheck[] = [];

  for (const rec of expected.sending) {
    const fqdn = relativeToFqdn(rec.name, domain);
    if (rec.record_type === "TXT") {
      const found = await txtAt(r, fqdn);
      const isSpf = /^v=spf1/i.test(stripQuotes(rec.value));
      const res = isSpf ? checkSpf(found, rec.value) : checkDkim(found, rec.value);
      checks.push({ kind: isSpf ? "spf" : "dkim", name: fqdn, expected: rec.value, ...res });
    } else if (rec.record_type === "CNAME") {
      const found = (await safe(r.resolveCname(fqdn), [] as string[])).map(host);
      const ok = found.includes(host(rec.value));
      checks.push({ kind: "cname", name: fqdn, expected: rec.value, status: found.length === 0 ? "missing" : ok ? "ok" : "mismatch", found });
    }
  }

  if (expected.receiving.length > 0) {
    const mx = await safe(r.resolveMx(host(domain)), [] as { exchange: string; priority: number }[]);
    checks.push({ kind: "mx", name: host(domain), ...checkMx(mx, expected.receiving) });
  }

  const dmarcName = `_dmarc.${host(domain)}`;
  checks.push({ kind: "dmarc", name: dmarcName, expected: "v=DMARC1; p=none; adkim=r; aspf=r", ...checkDmarc(await txtAt(r, dmarcName)) });

  const sendingOk = checks.filter((c) => c.kind === "spf" || c.kind === "dkim").every((c) => c.status === "ok");
  return { domain, checks, sendingOk, allOk: checks.every((c) => c.status === "ok") };
}

/** Result for a domain our DB lists as active but Mailgun does not know: it cannot send, and there is nothing to compare DNS to. */
export function notInMailgunHealth(domain: string): DnsHealth {
  return { domain, problem: "not_in_mailgun", checks: [], sendingOk: false, allOk: false };
}

/** True for the error getMailgunDnsRecords throws when Mailgun answers 404 for the domain. */
export function isMailgunDomainNotFound(err: unknown): boolean {
  return /Mailgun get domain failed: 404/.test((err as Error)?.message ?? "");
}
