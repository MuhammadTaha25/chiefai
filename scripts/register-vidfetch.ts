// One-off script: completes Hostinger registration for vidfetch.online, which
// was already charged to the client via Stripe but never registered because
// purchaseDomain() was missing payment_method_id (fixed in src/lib/hostinger.ts).
// Run with: npx tsx scripts/register-vidfetch.ts
// Reads credentials from .env.local — nothing hardcoded here.

import * as fs from "fs";
import * as path from "path";

const envPath = path.resolve(__dirname, "..", ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim();
}

const HOSTINGER_BASE_URL = process.env.HOSTINGER_BASE_URL ?? "https://developers.hostinger.com";
const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;
const WHOIS_PROFILE_ID = Number(process.env.HOSTINGER_WHOIS_PROFILE_ID);
const PAYMENT_METHOD_ID = Number(process.env.HOSTINGER_PAYMENT_METHOD_ID);

const DOMAIN = "vidfetch.online";
const TLD = "online";

interface CatalogPrice {
  id: string;
  period: number;
  period_unit: string;
}
interface CatalogItem {
  name: string;
  prices: CatalogPrice[];
}

async function hostingerFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  if (!HOSTINGER_API_KEY) throw new Error("HOSTINGER_API_KEY is not set in .env.local");

  const res = await fetch(`${HOSTINGER_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HOSTINGER_API_KEY}`,
      ...init?.headers,
    },
  });

  const text = await res.text();
  console.log(`[${init?.method ?? "GET"} ${pathname}] status:`, res.status);
  if (!res.ok) throw new Error(`${pathname} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function main() {
  if (!WHOIS_PROFILE_ID) throw new Error("HOSTINGER_WHOIS_PROFILE_ID is not set in .env.local");
  if (!PAYMENT_METHOD_ID) throw new Error("HOSTINGER_PAYMENT_METHOD_ID is not set in .env.local");

  const items = await hostingerFetch<CatalogItem[]>(
    `/api/billing/v1/catalog?category=DOMAIN&name=${encodeURIComponent(`.${TLD.toUpperCase()}*`)}`
  );

  const exact = items.find((i) => i.name.trim().toUpperCase() === `.${TLD.toUpperCase()} DOMAIN`);
  if (!exact) throw new Error(`Catalog item not found for TLD ${TLD}`);

  const oneYear = exact.prices.find((p) => p.period === 1 && p.period_unit === "year") ?? exact.prices[0];
  console.log("item_id:", oneYear.id);

  const result = await hostingerFetch("/api/domains/v1/portfolio", {
    method: "POST",
    body: JSON.stringify({
      domain: DOMAIN,
      item_id: oneYear.id,
      payment_method_id: PAYMENT_METHOD_ID,
      domain_contacts: {
        owner_id: WHOIS_PROFILE_ID,
        admin_id: WHOIS_PROFILE_ID,
        billing_id: WHOIS_PROFILE_ID,
        tech_id: WHOIS_PROFILE_ID,
      },
    }),
  });

  console.log("purchase result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
