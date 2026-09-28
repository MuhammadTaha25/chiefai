import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { checkDomainAvailability, getDomainCatalogItem, sellPriceForCatalogPrice } from "@/lib/hostinger";

const DEFAULT_TLDS = ["com", "net", "io", "org", "online", "shop"];

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain, tlds } = await req.json();
  if (!domain || typeof domain !== "string") {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  // Hostinger's availability API wants the bare name (no TLD) plus a list of
  // TLDs to check it against — passing "infomist.com" as the domain and
  // "com" as a tld produces an invalid combined name ("infomist.com.com")
  // and Hostinger rejects the whole request with a 422. If the client typed
  // a TLD themselves (e.g. "infomist.com"), strip it and search that TLD
  // specifically instead of silently ignoring what they asked for.
  const trimmed = domain.trim().toLowerCase();
  const dotIndex = trimmed.indexOf(".");
  const baseName = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const typedTld = dotIndex === -1 ? null : trimmed.slice(dotIndex + 1);

  if (!baseName) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  const tldList: string[] =
    Array.isArray(tlds) && tlds.length > 0 ? tlds : typedTld ? [typedTld] : DEFAULT_TLDS;

  try {
    const availability = await checkDomainAvailability(baseName, tldList);

    const results = await Promise.all(
      availability.map(async (a) => {
        const tld = a.domain.split(".").slice(1).join(".");
        const catalog = a.is_available ? await getDomainCatalogItem(tld).catch(() => null) : null;
        const sellPrice = catalog ? sellPriceForCatalogPrice(catalog.price) : null;
        return {
          domain: a.domain,
          is_available: a.is_available,
          restriction: a.restriction,
          catalog_item_id: catalog?.itemId ?? null,
          price_minor_units: sellPrice?.amountMinorUnits ?? null,
          price_currency: sellPrice?.currency ?? null,
        };
      })
    );

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
