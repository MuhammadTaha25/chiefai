"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ProposalWithLead {
  id: string;
  lead_id: string | null;
  amount: number | null;
  status: string;
  sent_at: string;
  decided_at: string | null;
  leads: { name: string | null; company: string | null } | null;
}

const STAGES: { id: string; label: string; accent: string }[] = [
  { id: "sent", label: "Sent", accent: "bg-blue-500" },
  { id: "negotiation", label: "Negotiation", accent: "bg-amber-500" },
  { id: "won", label: "Won", accent: "bg-green-500" },
  { id: "lost", label: "Lost", accent: "bg-red-500" },
];

const fmt = (n: number | null) =>
  n == null ? "$0" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export interface OutreachCard {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  stage: string;
  detail: string;
  at: string | null;
}

export default function PipelineBoard({ proposals, outreach = [] }: { proposals: ProposalWithLead[]; outreach?: OutreachCard[] }) {
  const router = useRouter();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(proposalId: string, status: string) {
    setBusyId(proposalId);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to move deal");
      if (data.webhook_error) {
        setError(`Moved to Won, but project creation failed: ${data.webhook_error}`);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function handleDrop(stage: string) {
    setOverStage(null);
    const proposal = proposals.find((p) => p.id === dragId);
    setDragId(null);
    if (!proposal || proposal.status === stage) return;
    move(proposal.id, stage);
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const items = proposals.filter((p) => p.status === stage.id);
          const auto = outreach.filter((o) => o.stage === stage.id);
          const total = items.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.id);
              }}
              onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
              onDrop={() => handleDrop(stage.id)}
              className={`flex min-h-56 flex-col rounded-lg border p-3 transition-colors ${
                overStage === stage.id
                  ? "border-zinc-400 bg-zinc-50 dark:border-zinc-500 dark:bg-zinc-900"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${stage.accent}`} />
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                  {stage.label}
                </p>
                <span className="ml-auto text-xs text-zinc-400">{items.length + auto.length}</span>
              </div>
              <p className="mb-3 text-sm font-medium">{fmt(total)}</p>

              <div className="flex flex-col gap-2">
                {items.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragEnd={() => setDragId(null)}
                    className={`cursor-grab rounded-md border border-zinc-200 bg-white p-3 text-left transition-opacity active:cursor-grabbing dark:border-zinc-800 dark:bg-zinc-950 ${
                      dragId === p.id ? "opacity-50" : ""
                    } ${busyId === p.id ? "pointer-events-none opacity-60" : ""}`}
                  >
                    <p className="text-sm font-medium">{p.leads?.company || p.leads?.name || "Untitled deal"}</p>
                    {p.leads?.company && p.leads?.name && (
                      <p className="text-xs text-zinc-500">{p.leads.name}</p>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-zinc-400">
                        {new Date(p.sent_at).toLocaleDateString()}
                      </span>
                      <span className="text-sm font-medium">{fmt(p.amount)}</span>
                    </div>
                  </div>
                ))}
                {auto.map((o) => (
                  <div key={o.id} className="rounded-md border border-zinc-200 bg-white p-3 text-left dark:border-zinc-800 dark:bg-zinc-950">
                    <p className="text-sm font-medium">{o.company || o.name || o.email || "Lead"}</p>
                    {o.email && <p className="truncate text-xs text-zinc-500">{o.email}</p>}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-zinc-400">{o.at ? new Date(o.at).toLocaleDateString() : ""}</span>
                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{o.detail}</span>
                    </div>
                  </div>
                ))}
                {items.length + auto.length === 0 && (
                  <p className="py-4 text-center text-xs text-zinc-400">No leads at this stage yet</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
