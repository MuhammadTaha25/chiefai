const HOSTINGER_BASE_URL = process.env.HOSTINGER_BASE_URL ?? "https://developers.hostinger.com";
const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;

/**
 * Server-only. Wraps the Hostinger API (ZERNIO_META_ADS_SPEC.md §6) for
 * domain availability search and registration. Never call from the browser —
 * always go through a Next.js API route.
 */
async function hostingerFetch<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<T> {
  if (!HOSTINGER_API_KEY) throw new Error("HOSTINGER_API_KEY is not set");

  const res = await fetch(`${HOSTINGER_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HOSTINGER_API_KEY}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hostinger API ${path} failed: ${res.status} ${text}`);
  }

  return res.json();
}

export interface DomainAvailability {
  domain: string;
  is_available: boolean;
  is_alternative: boolean;
  restriction: string | null;
}

export function checkDomainAvailability(domain: string, tlds: string[]) {
  return hostingerFetch<DomainAvailability[]>("/api/domains/v1/availability", {
    method: "POST",
    body: JSON.stringify({ domain, tlds, with_alternatives: false }),
  });
}

interface CatalogPrice {
  id: string;
  name: string;
  currency: string;
  price: number;
  first_period_price: number;
  period: number;
  period_unit: string;
}

interface CatalogItem {
  id: string;
  name: string;
  category: string;
  prices: CatalogPrice[];
}

/**
 * Looks up the 1-year registration price for a TLD, e.g. tld "com" ->
 * catalog item named exactly ".COM Domain". The `name=` filter is a wildcard
 * match ("*" suffix), so ".COM*" also matches ".COM.CO", ".COM.ES", etc — we
 * still need an exact name match to pick the right TLD.
 *
 * `item_id` for the purchase call is the PRICE id (e.g.
 * "hostingerpk-domain-com-pkr-1y"), not the parent catalog item's id — the
 * catalog item groups multiple billing-period prices under one TLD.
 */
export async function getDomainCatalogItem(tld: string): Promise<{ itemId: string; price: CatalogPrice } | null> {
  const items = await hostingerFetch<CatalogItem[]>(
    `/api/billing/v1/catalog?category=DOMAIN&name=${encodeURIComponent(`.${tld.toUpperCase()}*`)}`
  );
  const exact = items.find((i) => i.name.trim().toUpperCase() === `.${tld.toUpperCase()} DOMAIN`);
  if (!exact) return null;

  const oneYear = exact.prices.find((p) => p.period === 1 && p.period_unit === "year") ?? exact.prices[0];
  if (!oneYear) return null;

  return { itemId: oneYear.id, price: oneYear };
}

// No margin on top of Hostinger's own cost — the client is charged exactly
// what we pay Hostinger for the domain. Keep this the single source of truth
// so search display and checkout charging can never drift apart.
export const DOMAIN_MARKUP_MULTIPLIER = 1;

/**
 * Hostinger's first_period_price is the actual first-year registration cost
 * (what we pay Hostinger) — the discounted amount shown in their own UI, not
 * the renewal price. Confirmed against the live catalog: amounts are in the
 * currency's MINOR unit (paisa/cents) — e.g. .com first_period_price 299900
 * is Rs. 2999.00, .online's 29900 is Rs. 299.00. Do not treat these as major
 * units; the returned `amountMinorUnits` is what Stripe's unit_amount expects
 * directly, no further ×100 conversion.
 */
export function sellPriceForCatalogPrice(price: CatalogPrice) {
  const costMinorUnits = price.first_period_price ?? price.price;
  const amountMinorUnits = Math.round(costMinorUnits * DOMAIN_MARKUP_MULTIPLIER);
  return { amountMinorUnits, currency: price.currency };
}

/**
 * Recovery path for a domain stuck "awaiting setup": the billing order went
 * through and the domain shows up in the portfolio, but the registrar-side
 * registration never completed (GET .../portfolio/{domain} 404s with
 * "[Domains:2006] Domain is not registered at Hostinger" even though the
 * portfolio list shows it). Calling purchaseDomain again in that state 422s
 * with "Domain is already registered" — this endpoint (undocumented in the
 * public API reference, found by probing) finishes that same already-paid
 * order instead of placing a new one.
 */
export function completeDomainSetup(domain: string) {
  const whoisProfileIdRaw = process.env.HOSTINGER_WHOIS_PROFILE_ID;
  if (!whoisProfileIdRaw) throw new Error("HOSTINGER_WHOIS_PROFILE_ID is not set");
  const whoisProfileId = Number(whoisProfileIdRaw);

  return hostingerFetch<{ message: string }>(`/api/domains/v1/portfolio/${domain}/setup`, {
    method: "POST",
    body: JSON.stringify({
      domain,
      domain_contacts: {
        owner_id: whoisProfileId,
        admin_id: whoisProfileId,
        billing_id: whoisProfileId,
        tech_id: whoisProfileId,
      },
    }),
  });
}

/**
 * Ground truth for "is this domain actually registered" — placing the order
 * via purchaseDomain() only means Hostinger accepted and billed it, not that
 * ICANN/registry registration finished. Confirmed live: a domain can sit in
 * the portfolio for minutes with no record at all (empty {} response, not
 * even a 404) before this returns { status: "Active" }. Never mark our own
 * domain_purchases row "registered" without checking this first.
 */
export async function getPortfolioStatus(domain: string): Promise<string | null> {
  try {
    const result = await hostingerFetch<{ domain?: string; status?: string }>(
      `/api/domains/v1/portfolio/${domain}`
    );
    return result.status ?? null;
  } catch {
    return null;
  }
}

export interface PortfolioEntry {
  id: number;
  domain: string;
  status: string;
}

/**
 * The portfolio LIST entry for one domain — the only way to see a domain that
 * is in the portfolio but not yet Active.
 *
 * Confirmed live: GET /portfolio/{domain} 404s with "[Domains:2006] Domain is
 * not registered at Hostinger" for a domain that IS in the portfolio and
 * sitting at status "pending_verification" (Hostinger accepted and billed the
 * order; the registrar is waiting for the registrant to click the ICANN
 * verification email). The list endpoint reports that same domain as
 * "pending_verification".
 *
 * So a null from getPortfolioStatus() must never be read as "no order exists":
 * it cannot tell "the order failed" apart from "waiting on the registrant to
 * verify an email". Anything that needs to distinguish those has to ask here.
 */
export async function getPortfolioEntry(domain: string): Promise<PortfolioEntry | null> {
  try {
    const list = await hostingerFetch<PortfolioEntry[]>("/api/domains/v1/portfolio");
    if (!Array.isArray(list)) return null;
    return list.find((d) => String(d?.domain ?? "").toLowerCase() === domain.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

interface HostingerZoneRecord {
  type: string;
  name: string;
  ttl?: number;
  records: { content: string; priority?: number }[];
}

/**
 * Adds one DNS record set to a domain's Hostinger zone and reads the zone
 * back to confirm it actually landed — a 200/"Request accepted" from this
 * API is not proof the record exists (confirmed live: batching multiple
 * record types together sometimes 500s with nothing written), so every
 * caller must treat the write as unconfirmed until this returns true.
 */
async function addZoneRecordAndVerify(rootDomain: string, entry: HostingerZoneRecord): Promise<boolean> {
  // A recreated Mailgun domain (e.g. after a plan change deleted it) comes back
  // with NEW DKIM keys, but the old record still sits in the zone under the
  // same name/type. Adding with overwrite:false would leave the stale value
  // (or a second conflicting one) in place, so verification never passes.
  // Replace only THIS (type, name) set when its content differs — never the
  // whole zone.
  const current = await hostingerFetch<{ type: string; name: string; records: { content: string }[] }[]>(
    `/api/dns/v1/zones/${rootDomain}`
  );
  const existing = current.find((z) => z.type === entry.type && z.name === entry.name);
  if (existing) {
    const wanted = entry.records.map((r) => r.content.replace(/^"|"$/g, ""));
    const same =
      existing.records.length === wanted.length &&
      wanted.every((w) => existing.records.some((e) => e.content.replace(/^"|"$/g, "") === w));
    if (same) return true;
    await hostingerFetch(`/api/dns/v1/zones/${rootDomain}`, {
      method: "DELETE",
      body: JSON.stringify({ filters: [{ name: entry.name, type: entry.type }] }),
    });
  }
  await hostingerFetch(`/api/dns/v1/zones/${rootDomain}`, {
    method: "PUT",
    body: JSON.stringify({ overwrite: false, zone: [entry] }),
  });

  const zone = await hostingerFetch<{ type: string; name: string; records: { content: string }[] }[]>(
    `/api/dns/v1/zones/${rootDomain}`
  );
  const match = zone.find((z) => z.type === entry.type && z.name === entry.name);
  if (!match) return false;
  return entry.records.every((wanted) =>
    match.records.some((existing) => existing.content.includes(wanted.content.replace(/^"|"$/g, "")))
  );
}

/**
 * Writes every DNS record Mailgun requires for `mailgunDomain` (a subdomain
 * of `rootDomain`, e.g. "sales.example.com" under "example.com") into
 * Hostinger's zone, verifying each write individually — this is what used to
 * be delegated to an n8n workflow that reported success while silently
 * failing to write anything. Returns which records actually got confirmed so
 * the caller can record a truthful dns_status instead of assuming success.
 */
export async function provisionMailgunDnsRecords(
  rootDomain: string,
  mailgunDomain: string,
  records: {
    sending: { record_type: string; name: string; value: string }[];
    receiving: { record_type: string; value: string; priority?: string }[];
  }
): Promise<{ allConfirmed: boolean; failures: string[] }> {
  const suffix = `.${rootDomain}`;
  // Mailgun reports a record name either fully qualified (sometimes with a
  // trailing dot) or already relative. The apex — which is exactly what a
  // root-domain Mailgun setup needs for its SPF TXT and its MX — has to become
  // "@", the notation Hostinger's zone API uses for the root (confirmed against
  // a live zone). Passed through verbatim it produced "example.com.example.com".
  const relativeName = (fqdn: string) => {
    const name = fqdn.replace(/\.$/, "");
    if (name.toLowerCase() === rootDomain.toLowerCase()) return "@";
    return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  };
  const failures: string[] = [];

  for (const record of records.sending) {
    const name = relativeName(record.name);
    const entry: HostingerZoneRecord =
      record.record_type === "TXT"
        ? { type: "TXT", name, ttl: 3600, records: [{ content: `"${record.value}"` }] }
        : { type: "CNAME", name, ttl: 3600, records: [{ content: record.value.endsWith(".") ? record.value : `${record.value}.` }] };

    const ok = await addZoneRecordAndVerify(rootDomain, entry).catch(() => false);
    if (!ok) failures.push(`${record.record_type} ${name}`);
  }

  if (records.receiving.length > 0) {
    const mxName = relativeName(mailgunDomain);
    const entry: HostingerZoneRecord = {
      type: "MX",
      name: mxName,
      ttl: 3600,
      records: records.receiving.map((r) => ({
        content: `${r.priority ?? "10"} ${r.value.endsWith(".") ? r.value : `${r.value}.`}`,
      })),
    };
    const ok = await addZoneRecordAndVerify(rootDomain, entry).catch(() => false);
    if (!ok) failures.push(`MX ${mxName}`);
  }

  return { allConfirmed: failures.length === 0, failures };
}

/**
 * Writes OUR OWN domain-ownership TXT challenge record (see
 * domain-ownership-core.ts) into a Hostinger zone we actually control — only
 * called when the domain being connected via "I already have a domain" turns
 * out to already sit in this same Hostinger account's portfolio (see
 * getPortfolioEntry). Never called for a domain registered elsewhere; that
 * path still requires the client to add it themselves.
 */
export async function provisionOwnershipTxtRecord(rootDomain: string, hostname: string, token: string): Promise<boolean> {
  const suffix = `.${rootDomain}`;
  const name = hostname.replace(/\.$/, "");
  const relativeName = name.toLowerCase() === rootDomain.toLowerCase() ? "@" : name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  return addZoneRecordAndVerify(rootDomain, { type: "TXT", name: relativeName, ttl: 3600, records: [{ content: `"${token}"` }] }).catch(() => false);
}

interface HostingerPaymentMethod {
  id: number;
  identifier?: string;
  is_default: boolean;
  is_expired: boolean;
  is_suspended: boolean;
}

/**
 * The card Hostinger will actually bill for OUR fulfillment cost.
 *
 * Deliberately resolves the account's own DEFAULT payment method rather than
 * trusting HOSTINGER_PAYMENT_METHOD_ID. Confirmed live: a stale id pointing at
 * a card Hostinger no longer accepts still reports is_expired=false and
 * is_suspended=false — so it looks perfectly healthy right up until the
 * purchase call fails with an opaque "[Billing:9999] Request failed" and NO
 * domain is ever bought (this is exactly how several purchases were lost).
 * The default card is by definition the one Hostinger will charge.
 *
 * The env var is only a fallback for when the account exposes no usable
 * default, so a rotated card can never silently stop the whole buy flow again.
 */
export async function resolvePaymentMethodId(): Promise<number> {
  const configured = process.env.HOSTINGER_PAYMENT_METHOD_ID;
  try {
    const methods = await hostingerFetch<HostingerPaymentMethod[]>("/api/billing/v1/payment-methods");
    const usable = (m: HostingerPaymentMethod) => !m.is_expired && !m.is_suspended;
    const preferred = methods.find((m) => m.is_default && usable(m)) ?? methods.find(usable);
    if (preferred) return preferred.id;
  } catch {
    // fall through to the configured id
  }
  if (!configured) {
    throw new Error("No usable Hostinger payment method found and HOSTINGER_PAYMENT_METHOD_ID is not set");
  }
  return Number(configured);
}

export interface PurchaseDomainResult {
  id: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Registers the domain using our own Hostinger account's default payment
 * method — this is OUR fulfillment cost, separate from the Stripe charge
 * collected from the client.
 *
 * Hostinger's "default WHOIS profile" (set in hPanel) is scoped per TLD it
 * was created against — a profile created for .com does NOT get applied
 * automatically to a .online (or any other TLD) purchase, even if marked
 * default. The API requires domain_contacts explicitly on every purchase, so
 * we always pass our one WHOIS profile (HOSTINGER_WHOIS_PROFILE_ID) for all
 * four contact roles; Hostinger accepts that profile across TLDs when passed
 * this way, even though it's tagged "com" in hPanel.
 *
 * A successful call may return HTTP 202 with status "payment_initiated" —
 * the order is accepted but billed asynchronously, so it does NOT mean the
 * domain is registered. Callers must confirm via the portfolio (see
 * getPortfolioEntry), never treat the order id alone as success.
 */
export async function purchaseDomain(domain: string, itemId: string) {
  const whoisProfileIdRaw = process.env.HOSTINGER_WHOIS_PROFILE_ID;
  if (!whoisProfileIdRaw) throw new Error("HOSTINGER_WHOIS_PROFILE_ID is not set");
  // Hostinger's schema types these as integers — sending them as strings
  // (env vars are always strings) produces an opaque "Billing:9999 Request
  // failed" instead of a validation error, so coerce explicitly.
  const whoisProfileId = Number(whoisProfileIdRaw);
  const paymentMethodId = await resolvePaymentMethodId();

  return hostingerFetch<PurchaseDomainResult>("/api/domains/v1/portfolio", {
    method: "POST",
    body: JSON.stringify({
      domain,
      item_id: itemId,
      payment_method_id: paymentMethodId,
      domain_contacts: {
        owner_id: whoisProfileId,
        admin_id: whoisProfileId,
        billing_id: whoisProfileId,
        tech_id: whoisProfileId,
      },
    }),
  });
}

/**
 * Adds a monitoring-only DMARC policy (p=none) to a domain that has none, so mailbox providers see a
 * complete SPF + DKIM + DMARC set. Never overwrites: an existing _dmarc record (the owner's own policy) is
 * left exactly as it is. Read back after the write, like every other DNS record here. Returns what happened.
 */
export async function ensureDmarcRecord(rootDomain: string): Promise<"exists" | "added" | "failed"> {
  const zone = await hostingerFetch<{ type: string; name: string; records: { content: string }[] }[]>(
    `/api/dns/v1/zones/${rootDomain}`
  );
  if (zone.some((z) => z.type === "TXT" && z.name === "_dmarc")) return "exists";

  await hostingerFetch(`/api/dns/v1/zones/${rootDomain}`, {
    method: "PUT",
    body: JSON.stringify({
      overwrite: false,
      zone: [{ type: "TXT", name: "_dmarc", ttl: 3600, records: [{ content: '"v=DMARC1; p=none; adkim=r; aspf=r"' }] }],
    }),
  });

  const after = await hostingerFetch<{ type: string; name: string; records: { content: string }[] }[]>(
    `/api/dns/v1/zones/${rootDomain}`
  );
  const match = after.find((z) => z.type === "TXT" && z.name === "_dmarc");
  return match?.records.some((r) => r.content.includes("v=DMARC1")) ? "added" : "failed";
}
