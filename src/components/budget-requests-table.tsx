"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BudgetRequest } from "@/types/db";

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  declined: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  pending_human: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function RequestBudgetForm({ onDecided }: { onDecided: () => void }) {
  const [form, setForm] = useState({
    department: "marketing",
    requested_amount: "100",
    current_spend: "",
    cpl: "",
    available_cash: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ decision: string; pausedCount?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/finance/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: form.department,
          requested_amount: Number(form.requested_amount),
          current_spend: form.current_spend ? Number(form.current_spend) : undefined,
          cpl: form.cpl ? Number(form.cpl) : undefined,
          available_cash: form.available_cash ? Number(form.available_cash) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (data.request_update_error || data.budget_update_error) {
        throw new Error(
          `Decision was "${data.decision}" but saving it failed: ${
            data.request_update_error || data.budget_update_error
          }`
        );
      }
      setResult({ decision: data.decision, pausedCount: data.ad_pause?.paused?.length });
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div>
        <label className="block text-xs text-zinc-500">Department</label>
        <input
          value={form.department}
          onChange={(e) => set("department", e.target.value)}
          className="mt-1 w-32 rounded-md border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-transparent"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500">Requested ($)</label>
        <input
          type="number"
          value={form.requested_amount}
          onChange={(e) => set("requested_amount", e.target.value)}
          className="mt-1 w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-transparent"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500">Current spend ($)</label>
        <input
          type="number"
          value={form.current_spend}
          onChange={(e) => set("current_spend", e.target.value)}
          className="mt-1 w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-transparent"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500">CPL (audit signal)</label>
        <input
          type="number"
          placeholder="cost per lead"
          value={form.cpl}
          onChange={(e) => set("cpl", e.target.value)}
          className="mt-1 w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-transparent"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500">Available cash</label>
        <input
          type="number"
          value={form.available_cash}
          onChange={(e) => set("available_cash", e.target.value)}
          className="mt-1 w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-transparent"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {loading ? "Asking Finance…" : "Request budget"}
      </button>
      {result && (
        <span
          className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLES[result.decision] ?? STATUS_STYLES.pending}`}
        >
          Decision: {result.decision.replace(/_/g, " ")}
        </span>
      )}
      {result?.decision === "declined" && result.pausedCount != null && (
        <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {result.pausedCount > 0 ? `${result.pausedCount} ad(s) auto-paused` : "No active ads to pause"}
        </span>
      )}
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </form>
  );
}

export default function BudgetRequestsTable({ requests }: { requests: BudgetRequest[] }) {
  const router = useRouter();

  return (
    <div className="mt-3">
      <RequestBudgetForm onDecided={() => router.refresh()} />

      <div className="mt-4 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Requested</th>
              <th className="px-4 py-3 font-medium">Approved</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                <td className="px-4 py-3 capitalize">{r.department || "—"}</td>
                <td className="px-4 py-3">${Number(r.requested_amount).toLocaleString()}</td>
                <td className="px-4 py-3">{r.approved_amount != null ? `$${Number(r.approved_amount).toLocaleString()}` : "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs capitalize ${STATUS_STYLES[r.status] ?? STATUS_STYLES.pending}`}>
                    {r.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-500">{r.decision_reason || "—"}</td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  No budget requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
