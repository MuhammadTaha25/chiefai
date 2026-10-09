"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal, ArrowUpDown } from "lucide-react";
import type { WorkspaceLead, WorkspaceStage } from "@/lib/workspace-data";
import { STAGE_LABEL, avatarColorFor, relativeTime } from "@/lib/workspace-data";
import { LeadCard, Avatar } from "@/components/workspace/LeadCard";
import { LeadDrawer } from "@/components/workspace/LeadDrawer";
import { StatusBadge } from "@/components/workspace/StatusBadge";
import { EmptyState } from "@/components/workspace/EmptyState";

const STAGE_TONE = { sent: "blue", negotiation: "violet", won: "green", lost: "gray" } as const;
const STAGES: WorkspaceStage[] = ["sent", "negotiation", "won", "lost"];
const TABS: ("All" | WorkspaceStage)[] = ["All", ...STAGES];

export function LeadsPipelineView({ leads }: { leads: WorkspaceLead[] }) {
  const [tab, setTab] = useState<"All" | WorkspaceStage>("All");
  const [query, setQuery] = useState("");
  const [activeLead, setActiveLead] = useState<WorkspaceLead | null>(null);

  const filtered = useMemo(() => {
    return leads.filter((lead) => {
      const stageMatch = tab === "All" || lead.stage === tab;
      const q = query.trim().toLowerCase();
      const queryMatch = !q || lead.name.toLowerCase().includes(q) || lead.company.toLowerCase().includes(q) || lead.stage.toLowerCase().includes(q);
      return stageMatch && queryMatch;
    });
  }, [leads, tab, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="ns-title text-[24px]">Leads &amp; pipeline</h1>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="ns-scrollbar flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="ns-focus shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium"
              style={tab === t ? { background: "rgba(115,87,255,0.1)", color: "#5B43D6" } : { color: "#667085" }}
            >
              {t === "All" ? "All" : STAGE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" style={{ color: "#98A2B3" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search leads"
              aria-label="Search leads"
              className="ns-focus h-9 w-[200px] rounded-full border pl-9 pr-3 text-[13px]"
              style={{ borderColor: "#E4E7EC" }}
            />
          </div>
          <button aria-label="Filter" className="ns-focus grid size-9 place-items-center rounded-full border" style={{ borderColor: "#E4E7EC", color: "#667085" }}>
            <SlidersHorizontal className="size-4" />
          </button>
          <button aria-label="Sort" className="ns-focus grid size-9 place-items-center rounded-full border" style={{ borderColor: "#E4E7EC", color: "#667085" }}>
            <ArrowUpDown className="size-4" />
          </button>
        </div>
      </div>

      <div className="ns-scrollbar grid grid-flow-col auto-cols-[260px] gap-4 overflow-x-auto pb-2 lg:grid-flow-row lg:auto-cols-auto lg:grid-cols-4">
        {STAGES.map((stage) => {
          const stageLeads = leads.filter((l) => l.stage === stage);
          return (
            <div key={stage} className="ns-card p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="ns-label">{STAGE_LABEL[stage]}</span>
                <span className="text-[11px] font-semibold" style={{ color: "#98A2B3" }}>{stageLeads.length}</span>
              </div>
              <div className="space-y-2">
                {stageLeads.map((lead) => (
                  <LeadCard key={lead.id} lead={lead} onOpen={setActiveLead} />
                ))}
                {stageLeads.length === 0 && <p className="px-1 text-[11px]" style={{ color: "#98A2B3" }}>No leads at this stage</p>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="ns-card">
        <div className="p-5 pb-3">
          <h3 className="ns-section-title">All leads</h3>
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No leads match this search." description="Try a different name, company, or stage." />
        ) : (
          <div className="ns-scrollbar overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-y" style={{ borderColor: "var(--ns-border)" }}>
                  {["Lead", "Company", "Deal value", "Stage", "Source", "Last touch"].map((h) => (
                    <th key={h} className="ns-label px-5 py-3 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead) => (
                  <tr
                    key={lead.id}
                    tabIndex={0}
                    onClick={() => setActiveLead(lead)}
                    className="ns-focus cursor-pointer border-b transition-colors hover:bg-[#F7F8FC]"
                    style={{ borderColor: "var(--ns-border)" }}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={lead.name} color={avatarColorFor(lead.name)} size={28} />
                        <span className="font-semibold" style={{ color: "#101828" }}>{lead.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{lead.company}</td>
                    <td className="px-5 py-3 font-semibold" style={{ color: "#101828" }}>{lead.amount != null ? `$${lead.amount.toLocaleString()}` : "—"}</td>
                    <td className="px-5 py-3"><StatusBadge label={STAGE_LABEL[lead.stage]} tone={STAGE_TONE[lead.stage]} /></td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{lead.source}</td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{relativeTime(lead.lastTouchISO)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <LeadDrawer lead={activeLead} onClose={() => setActiveLead(null)} />
    </div>
  );
}

export default LeadsPipelineView;
