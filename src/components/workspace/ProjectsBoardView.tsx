"use client";

import { useState } from "react";
import type { WorkspaceProject } from "@/lib/workspace-data";
import { fmtMoney } from "@/lib/workspace-data";
import { MetricCard } from "@/components/workspace/MetricCard";
import { StatusBadge, type StatusTone } from "@/components/workspace/StatusBadge";
import { EmptyState } from "@/components/workspace/EmptyState";
import { Rocket, ShieldAlert, DollarSign } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  started: "Started",
  in_development: "In development",
  qa: "QA",
  client_review: "Client review",
  delivered: "Delivered",
  closed: "Closed",
  blocked: "Blocked",
};

const STATUS_TONE: Record<string, StatusTone> = {
  not_started: "gray",
  started: "blue",
  in_development: "violet",
  qa: "violet",
  client_review: "orange",
  delivered: "green",
  closed: "green",
  blocked: "orange",
};

export function ProjectsBoardView({
  projects,
  activeCount,
  blockedCount,
  totalRevenue,
}: {
  projects: WorkspaceProject[];
  activeCount: number;
  blockedCount: number;
  totalRevenue: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <h1 className="ns-title text-[24px]">Projects</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Active projects" value={String(activeCount).padStart(2, "0")} context="Not yet delivered" icon={Rocket} />
        <MetricCard label="Blocked projects" value={String(blockedCount)} context="Need a decision" trend={blockedCount > 0 ? "down" : "neutral"} icon={ShieldAlert} />
        <MetricCard label="Total project revenue" value={fmtMoney(totalRevenue)} context="Across all projects" icon={DollarSign} />
      </div>

      {projects.length === 0 ? (
        <div className="ns-card">
          <EmptyState title="No projects yet." description="Projects created from won deals will show up here." />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-5">
          <div className="ns-card lg:col-span-3">
            <div className="p-5 pb-3">
              <h3 className="ns-section-title">All projects</h3>
            </div>
            <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className="ns-focus flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-[#F7F8FC]"
                    style={p.id === selectedId ? { background: "rgba(115,87,255,0.06)" } : undefined}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{p.name}</p>
                      <p className="ns-body truncate text-[12px]">{p.deadlineISO ? `Due ${new Date(p.deadlineISO).toLocaleDateString()}` : "No deadline set"}</p>
                    </div>
                    <StatusBadge label={STATUS_LABEL[p.status] ?? p.status} tone={p.isBlocked ? "orange" : STATUS_TONE[p.status] ?? "gray"} />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="ns-card lg:col-span-2">
            <div className="p-5 pb-3">
              <h3 className="ns-section-title">Project snapshot</h3>
            </div>
            {selected && (
              <div className="px-5 pb-5">
                <div className="flex items-center justify-between">
                  <p className="text-[15px] font-semibold" style={{ color: "#101828" }}>{selected.name}</p>
                  <StatusBadge label={STATUS_LABEL[selected.status] ?? selected.status} tone={selected.isBlocked ? "orange" : STATUS_TONE[selected.status] ?? "gray"} />
                </div>
                <p className="ns-body mt-1 text-[12px]">
                  {selected.deadlineISO ? `Due ${new Date(selected.deadlineISO).toLocaleDateString()}` : "No deadline set"}
                </p>

                {selected.isBlocked && selected.blockReason && (
                  <div className="mt-4 rounded-xl p-3" style={{ background: "rgba(240,140,70,0.08)" }}>
                    <p className="text-[12px] font-semibold" style={{ color: "#C96A2A" }}>Blocked</p>
                    <p className="mt-1 text-[12px]" style={{ color: "#667085" }}>{selected.blockReason}</p>
                  </div>
                )}

                <dl className="mt-5 grid grid-cols-2 gap-3 text-[12px]">
                  <div className="ns-card p-3">
                    <dt className="ns-label mb-1">Revenue</dt>
                    <dd className="font-semibold" style={{ color: "#101828" }}>{fmtMoney(selected.revenue)}</dd>
                  </div>
                  <div className="ns-card p-3">
                    <dt className="ns-label mb-1">Cost</dt>
                    <dd className="font-semibold" style={{ color: "#101828" }}>{fmtMoney(selected.cost)}</dd>
                  </div>
                </dl>

                <a
                  href="/projects"
                  className="ns-focus mt-6 flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-[13px] font-semibold text-white"
                  style={{ background: "#7357FF" }}
                >
                  Open project workspace
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectsBoardView;
