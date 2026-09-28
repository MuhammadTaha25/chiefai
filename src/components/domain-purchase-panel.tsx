"use client";

import { useState } from "react";

interface SearchResult {
  domain: string;
  is_available: boolean;
  restriction: string | null;
  catalog_item_id: string | null;
  price_minor_units: number | null;
  price_currency: string | null;
}

function formatPrice(amountMinorUnits: number | null, currency: string | null) {
  if (amountMinorUnits == null || !currency) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(
      amountMinorUnits / 100
    );
  } catch {
    return `${(amountMinorUnits / 100).toFixed(2)} ${currency}`;
  }
}

export default function DomainPurchasePanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [checkoutUrls, setCheckoutUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/domains/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setResults(data.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function handleBuy(result: SearchResult) {
    if (!result.catalog_item_id) return;
    setBuying(result.domain);
    setError(null);
    try {
      const res = await fetch("/api/domains/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: result.domain,
          catalog_item_id: result.catalog_item_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start checkout");
      setCheckoutUrls((prev) => ({ ...prev, [result.domain]: data.checkout_url }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuying(null);
    }
  }

  return (
    <div className="panel panel-body space-y-4">
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="yourbusiness"
          className="flex-1 rounded-md border border-black/[.08] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
        />
        <button
          type="submit"
          disabled={searching}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}

      {results && (
        <ul className="divide-y divide-black/[.06] dark:divide-white/[.08]">
          {results.map((r) => (
            <li key={r.domain} className="flex items-center justify-between py-2">
              <span className={r.is_available ? "" : "text-zinc-500 line-through"}>{r.domain}</span>
              {r.is_available ? (
                checkoutUrls[r.domain] ? (
                  <a
                    href={checkoutUrls[r.domain]}
                    className="rounded-md bg-foreground px-3 py-1 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
                  >
                    Continue to payment →
                  </a>
                ) : (
                  <button
                    onClick={() => handleBuy(r)}
                    disabled={buying === r.domain || !r.catalog_item_id}
                    className="rounded-md border border-black/[.08] px-3 py-1 text-sm hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
                  >
                    {buying === r.domain
                      ? "Starting checkout…"
                      : `Buy${formatPrice(r.price_minor_units, r.price_currency) ? ` — ${formatPrice(r.price_minor_units, r.price_currency)}` : ""}`}
                  </button>
                )
              ) : (
                <span className="text-xs text-zinc-500">Taken</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
