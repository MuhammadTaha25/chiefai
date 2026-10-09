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

interface OwnershipChallenge {
  owned: boolean;
  hostname?: string;
  token?: string;
  expiresAt?: string;
}

const VERIFY_STATE_MESSAGE: Record<string, { text: string; tone: "ok" | "warn" | "error" }> = {
  active: { text: "Verified — you can create mailboxes below.", tone: "ok" },
  dns_failed: { text: "Sending/receiving records not detected yet — DNS may still be propagating.", tone: "warn" },
  ownership_owned_by_other: { text: "This domain is already connected to a different account.", tone: "error" },
  ownership_no_challenge: { text: "Start by entering this domain above first.", tone: "warn" },
  ownership_expired: { text: "This verification request expired. Enter the domain again to get a new one.", tone: "warn" },
  ownership_dns_not_found: { text: "Ownership TXT record not found yet. DNS may still be propagating — this can take a few minutes to a few hours.", tone: "warn" },
  ownership_dns_mismatch: { text: "Ownership TXT record found, but its value doesn't match exactly. Double-check what you added.", tone: "error" },
};

/**
 * "I already own a domain" path: the client's domain is hosted at a DNS
 * provider we don't control, so we can never write records into it the way
 * we do for a domain bought through Hostinger. Instead this shows exactly
 * what the client must add at their own DNS provider, then lets them ask us
 * to re-check once they have.
 *
 * Two independent checks happen on "check now": first an OWNERSHIP TXT
 * challenge unique to this client+domain (never satisfied by someone else's
 * DNS, and never inferred from Mailgun's shared "active" state — see the
 * Existing-Domain Feature Audit P0 fix), then, once that passes, the actual
 * Mailgun SPF/DKIM/MX verification.
 */
export default function DomainExternalSetup() {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<Records | null>(null);
  const [ownership, setOwnership] = useState<OwnershipChallenge | null>(null);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<string | null>(null);
  const [autoProvisioned, setAutoProvisioned] = useState(false);

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
      setOwnership(data.ownership ?? null);
      setActiveDomain(data.domain ?? clean);
      setAutoProvisioned(Boolean(data.autoProvisioned));
      setVerifyState(data.autoProvisioned ? (data.verifyState ?? null) : null);
      if (data.autoProvisioned && data.verifyState === "active") router.refresh();
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
      if (data.state === "active") {
        setOwnership({ owned: true });
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const verifyInfo = verifyState ? VERIFY_STATE_MESSAGE[verifyState] ?? { text: `Status: ${verifyState}`, tone: "warn" as const } : null;

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

      {records && activeDomain && autoProvisioned && (
        <div className="space-y-3">
          <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            {activeDomain} is already in your connected Hostinger account, so we added every DNS record
            (ownership, SPF/DKIM, MX, DMARC) for you automatically — nothing to copy anywhere.
          </p>
          {verifyInfo && (
            <p
              className={`text-sm ${
                verifyInfo.tone === "ok" ? "text-green-700 dark:text-green-400" : verifyInfo.tone === "error" ? "text-red-700 dark:text-red-400" : "text-zinc-500"
              }`}
            >
              {verifyInfo.text}
            </p>
          )}
          {verifyState && verifyState !== "active" && (
            <button
              onClick={handleVerify}
              disabled={busy}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {busy ? "Checking…" : "Check again"}
            </button>
          )}
        </div>
      )}

      {records && activeDomain && !autoProvisioned && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">
            Add these records at {activeDomain}&apos;s DNS provider (your registrar, or wherever its
            nameservers point). Propagation can take a few minutes to a few hours.
          </p>

          {ownership && !ownership.owned && ownership.hostname && ownership.token && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">
                Step 1 — Prove you own this domain
              </h3>
              <p className="text-xs text-zinc-500">
                We can&apos;t take your word for it — add this TXT record first, so nobody else can connect
                this domain to their own account by mistake.
              </p>
              <DnsTable
                title="Ownership verification"
                rows={[{ record_type: "TXT", name: ownership.hostname, value: ownership.token }]}
              />
            </div>
          )}

          {(!ownership || ownership.owned) && (
            <h3 className="text-sm font-medium">{ownership?.owned ? "Step 2 — Sending &amp; receiving" : "Sending &amp; receiving"}</h3>
          )}
          <DnsTable title="Sending (SPF / DKIM)" rows={records.sending} />
          <DnsTable title="Receiving (MX)" rows={records.receiving} />

          {/*
            P2 FIX (Existing-Domain Feature Audit, 2026-10-09): a purchased
            domain gets a DMARC record written automatically (ensureDmarcRecord
            in src/lib/hostinger.ts), but we can never write DNS for a zone we
            don't control — so external-domain clients previously got no DMARC
            guidance at all. This is advisory only: Mailgun doesn't manage or
            verify DMARC, so unlike the records above there is nothing to
            "check now" here — it's the client's own policy to set.
          */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recommended (DMARC)</h3>
            <p className="text-xs text-zinc-500">
              Not required to send, but strongly recommended for inbox placement. We can&apos;t add this for you
              on a domain we don&apos;t manage — add it yourself if {activeDomain} doesn&apos;t already have one.
            </p>
            <DnsTable
              title="DMARC"
              rows={[{ record_type: "TXT", name: `_dmarc.${activeDomain}`, value: "v=DMARC1; p=none; adkim=r; aspf=r" }]}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleVerify}
              disabled={busy}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {busy ? "Checking…" : "I've added these — check now"}
            </button>
            {verifyInfo && (
              <span
                className={`text-sm ${
                  verifyInfo.tone === "ok" ? "text-green-700 dark:text-green-400" : verifyInfo.tone === "error" ? "text-red-700 dark:text-red-400" : "text-zinc-500"
                }`}
              >
                {verifyInfo.text}
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
