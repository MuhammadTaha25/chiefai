"use client";

import { useState } from "react";
import { CheckSquare, Square, ArrowUpRight } from "lucide-react";
import { PROJECTS, type Project } from "@/lib/workspace-demo-data";
import { MetricCard } from "@/components/workspace/MetricCard";
import { StatusBadge } from "@/components/workspace/StatusBadge";
import { Rocket, ListChecks, Timer } from "lucide-react";

export default function ProjectsPage() {
  const [selectedId, setSelectedId] = useState(PROJECTS[0].id);
  const selected = PROJECTS.find((p) => p.id === selectedId) as Project;

  return (
    <div className="space-y-6">
      <h1 className="ns-title text-[24px]">Projects</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Active projects" value="06" context="Across 3 clients" icon={Rocket} />
        <MetricCard label="Tasks completed" value="78%" context="This quarter" trend="up" icon={ListChecks} />
        <MetricCard label="Billable hours" value="142h" context="This month" icon={Timer} />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="ns-card lg:col-span-3">
          <div className="p-5 pb-3">
            <h3 className="ns-section-title">Active projects</h3>
          </div>
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {PROJECTS.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelectedId(p.id)}
                  className="ns-focus flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-[#F7F8FC]"
                  style={p.id === selectedId ? { background: "rgba(115,87,255,0.06)" } : undefined}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{p.name}</p>
                    <p className="ns-body truncate text-[12px]">{p.client} · Due {p.due} · {p.tasksDone}/{p.tasksTotal} tasks</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusBadge label={p.health} tone={p.health === "On track" ? "green" : "orange"} />
                    <span className="text-[12px] font-semibold" style={{ color: "#667085" }}>{p.progress}%</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="ns-card lg:col-span-2">
          <div className="p-5 pb-3">
            <h3 className="ns-section-title">Project snapshot</h3>
          </div>
          <div className="px-5 pb-5">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-semibold" style={{ color: "#101828" }}>{selected.name}</p>
              <StatusBadge label={selected.health} tone={selected.health === "On track" ? "green" : "orange"} />
            </div>
            <p className="ns-body mt-1 text-[12px]">Owner: {selected.owner} · Due {selected.due}</p>

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-[12px]" style={{ color: "#667085" }}>
                <span>Overall progress</span>
                <span className="font-semibold" style={{ color: "#101828" }}>{selected.progress}%</span>
              </div>
              <div className="h-2 w-full rounded-full" style={{ background: "#F1F3F7" }}>
                <div
                  className="h-2 rounded-full"
                  style={{ width: `${selected.progress}%`, background: "#7357FF" }}
                />
              </div>
            </div>

            <div className="mt-5">
              <p className="ns-label mb-2">Upcoming tasks</p>
              <ul className="space-y-2">
                {selected.upcomingTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[13px]" style={{ color: t.done ? "#98A2B3" : "#101828" }}>
                    {t.done ? <CheckSquare className="size-4" style={{ color: "#16A36B" }} aria-hidden /> : <Square className="size-4" style={{ color: "#D0D5DD" }} aria-hidden />}
                    <span className={t.done ? "line-through" : ""}>{t.label}</span>
                  </li>
                ))}
              </ul>
            </div>

            <button className="ns-focus mt-6 flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-[13px] font-semibold text-white" style={{ background: "#7357FF" }}>
              Open project workspace <ArrowUpRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
