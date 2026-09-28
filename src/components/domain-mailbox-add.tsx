"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Adds a mailbox to a domain the client already owns (after the initial
 * post-purchase onboarding). The onboarding popup only appears once per
 * domain, so this is the entry point for "add another mailbox later".
 * Talks to /api/domains/mailboxes, which provisions the Mailgun domain + DNS
 * + inbound route behind the same code path onboarding uses.
 */
export default function DomainMailboxAdd({ domains }: { domains: string[] }) {
  const router = useRouter();
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (domains.length === 0) return null;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const cleanLocal = local.trim().toLowerCase();
    if (!cleanLocal) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/domains/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, locals: [cleanLocal] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create mailbox");
      const mb = data.mailboxes?.[0];
      setResult({
        ok: true,
        text: mb ? `${mb.address} → ${mb.status === "created" || mb.status === "already_exists" ? "ready" : mb.status}` : "Mailbox created",
      });
      setLocal("");
      router.refresh();
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-body space-y-3">
      <h2 className="text-lg font-semibold">Add a mailbox</h2>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-zinc-500">Domain</span>
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="rounded-md border border-black/[.08] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
          >
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-zinc-500">Mailbox name</span>
          <input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="sales"
            className="rounded-md border border-black/[.08] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
          />
        </label>
        <span className="pb-2 text-sm text-zinc-500">@{domain}</span>
        <button
          type="submit"
          disabled={busy || !local.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {busy ? "Adding…" : "Add mailbox"}
        </button>
      </form>
      {result && (
        <p className={`rounded-md p-3 text-sm ${result.ok ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
          {result.text}
        </p>
      )}
    </div>
  );
}
