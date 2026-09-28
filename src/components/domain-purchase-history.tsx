"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import DomainOnboardingFlow from "@/components/domain-onboarding-flow";

interface DomainPurchaseRow {
  id: string;
  domain: string;
  status: string;
  amount_cents: number;
  currency: string;
  hostinger_order_id: string | null;
  last_error: string | null;
  created_at: string;
}

function formatAmount(amountMinorUnits: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(
      amountMinorUnits / 100
    );
  } catch {
    return `${(amountMinorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const statusColor: Record<string, string> = {
  registered: "text-green-600",
  paid: "text-amber-600",
  registering: "text-amber-600",
  pending_payment: "text-zinc-500",
  payment_failed: "text-red-600",
  registration_failed: "text-red-600",
};

/**
 * The mailbox-setup dialog otherwise only ever appears once, right off the
 * Stripe checkout redirect (?domain_purchase=success). If the client closes
 * the tab, navigates away, or gets logged out before finishing it, there was
 * previously no way back in — this "Set up mailbox" button re-opens the same
 * flow for any already-registered domain, any time.
 */
export default function DomainPurchaseHistory({ purchases }: { purchases: DomainPurchaseRow[] }) {
  const router = useRouter();
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry(id: string) {
    setRetryingId(id);
    setRetryError(null);
    try {
      const res = await fetch(`/api/domains/purchases/${id}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Retry failed");
      router.refresh();
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Purchase history</h2>
      {retryError && (
        <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {retryError}
        </p>
      )}
      <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
              <th className="px-4 py-3 font-medium">Domain</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                <td className="px-4 py-3">{p.domain}</td>
                <td className={`px-4 py-3 capitalize ${statusColor[p.status] ?? ""}`} title={p.last_error ?? undefined}>
                  {p.status.replace(/_/g, " ")}
                </td>
                <td className="px-4 py-3">{formatAmount(p.amount_cents, p.currency)}</td>
                <td className="px-4 py-3 text-zinc-500">
                  {new Date(p.created_at).toLocaleDateString("en-US", { timeZone: "UTC" })}
                </td>
                <td className="px-4 py-3 text-right">
                  {p.status === "registered" && (
                    <button
                      onClick={() => setActiveDomain(p.domain)}
                      className="rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.06]"
                    >
                      Set up mailbox
                    </button>
                  )}
                  {(p.status === "registration_failed" || p.status === "paid") && (
                    <button
                      onClick={() => retry(p.id)}
                      disabled={retryingId === p.id}
                      className="rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
                    >
                      {retryingId === p.id ? "Retrying…" : "Retry registration"}
                    </button>
                  )}
                  {p.status === "registering" && (
                    <button
                      onClick={() => retry(p.id)}
                      disabled={retryingId === p.id}
                      className="rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
                      title="Hostinger is still finishing this registration — check again"
                    >
                      {retryingId === p.id ? "Checking…" : "Check status"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {purchases.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  No domain purchases yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {activeDomain && (
        <DomainOnboardingFlow
          domain={activeDomain}
          initialStep="mailboxes"
          onClose={() => setActiveDomain(null)}
        />
      )}
    </div>
  );
}
