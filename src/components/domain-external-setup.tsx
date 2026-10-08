"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface MailgunDnsRecord {
  record_type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  priority?: string;
}

interface Records {
  sending: MailgunDnsRecord[];
  receiving: MailgunDnsRecord[];
}

/**
 * "I already own a domain" path: the client's domain is hosted at a DNS
 * provider we don't control, so we can never write records into it the way
 * we do for a domain bought through Hostinger. Instead this shows exactly
 * what the client must add at their own DNS provider, then lets them ask us
 * to re-check once they have.
 */
export default function DomainExternalSetup() {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<Records | null>(null);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<string | null>(null);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    const clean = domain.trim().toLowerCase();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/domains/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: clean }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not register this domain");
      setRecords(data.records);
      setActiveDomain(clean);
      setVerifyState(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    if (!activeDomain) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/domains/external/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: activeDomain }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not verify this domain");
      setVerifyState(data.state);
      if (data.state === "active") router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-body space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Already have a domain?</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Use a domain you already own and manage its DNS yourself. We&apos;ll give you the records
          to add at your own DNS provider — we never write to DNS we don&apos;t control.
        </p>
      </div>

      {!records && (
        <form onSubmit={handleStart} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-zinc-500">Your domain</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="yourcompany.com"
              className="min-w-[220px] rounded-md border border-black/[.08] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !domain.trim()}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {busy ? "Setting up…" : "Use this domain"}
          </button>
        </form>
      )}

      {error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}

      {records && activeDomain && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">
            Add these records at {activeDomain}&apos;s DNS provider (your registrar, or wherever its
            nameservers point). Propagation can take a few minutes to a few hours.
          </p>

          <DnsTable title="Sending (SPF / DKIM)" rows={records.sending} />
          <DnsTable title="Receiving (MX)" rows={records.receiving} />

          <div className="flex items-center gap-3">
            <button
              onClick={handleVerify}
              disabled={busy}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {busy ? "Checking…" : "I've added these — check now"}
            </button>
            {verifyState && (
              <span className="text-sm text-zinc-500">
                {verifyState === "active"
                  ? "Verified — you can create mailboxes below."
                  : verifyState === "dns_failed"
                    ? "Records not detected yet — DNS may still be propagating."
                    : `Status: ${verifyState}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DnsTable({ title, rows }: { title: string; rows: MailgunDnsRecord[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto rounded-md border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-left text-xs">
          <thead className="bg-black/[.03] dark:bg-white/[.04]">
            <tr>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Value</th>
              {rows.some((r) => r.priority) && <th className="px-3 py-2 font-medium">Priority</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.record_type}-${r.name}-${i}`} className="border-t border-black/[.06] dark:border-white/[.08]">
                <td className="whitespace-nowrap px-3 py-2 font-mono">{r.record_type}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">{r.name}</td>
                <td className="max-w-[420px] break-all px-3 py-2 font-mono">{r.value}</td>
                {rows.some((rr) => rr.priority) && <td className="px-3 py-2 font-mono">{r.priority ?? ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
