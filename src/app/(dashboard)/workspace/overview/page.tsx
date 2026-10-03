"use client";

import { DollarSign, Target, FolderKanban, Clock3, CheckCircle2, Send, MoveRight, Receipt, ArrowRight } from "lucide-react";
import { MetricCard } from "@/components/workspace/MetricCard";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import { BarChart } from "@/components/workspace/BarChart";
import { REVENUE_MONTHS, PRIORITY_QUEUE, UPCOMING_WORK, ACTIVITY_EVENTS } from "@/lib/workspace-demo-data";

const ACTIVITY_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  success: { icon: CheckCircle2, color: "#16A36B" },
  info: { icon: Send, color: "#3485D8" },
  warning: { icon: Receipt, color: "#F08C46" },
  neutral: { icon: MoveRight, color: "#667085" },
};

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="ns-label mb-2">Thursday, October 3, 2026</p>
          <h1 className="ns-title">Good morning, Alex.</h1>
          <p className="ns-body mt-1">Here is what needs your attention today.</p>
        </div>
        <div className="flex gap-2">
          <button className="ns-focus rounded-full border px-4 py-2 text-[13px] font-semibold" style={{ borderColor: "#E4E7EC", color: "#344054" }}>
            This week
          </button>
          <button className="ns-focus rounded-full px-4 py-2 text-[13px] font-semibold text-white" style={{ background: "#7357FF" }}>
            Chief of staff
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Revenue this month" value="$24,680" context="18.4% vs last month" trend="up" icon={DollarSign} />
        <MetricCard label="Qualified pipeline" value="$86,400" context="12.8% vs last month" trend="up" icon={Target} />
        <MetricCard label="Active projects" value="06" context="2 due soon" trend="neutral" icon={FolderKanban} />
        <MetricCard label="Hours saved by AI" value="42.5h" context="8.6h this week" trend="up" icon={Clock3} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="ns-card lg:col-span-2">
          <SectionHeader
            eyebrow="Performance"
            title="Revenue overview"
            actions={
              <button className="ns-focus rounded-full border px-3 py-1.5 text-[12px] font-medium" style={{ borderColor: "#E4E7EC", color: "#344054" }}>
                Last 30 days
              </button>
            }
          />
          <div className="px-5 pb-5">
            <div className="mb-4 flex items-baseline gap-3">
              <span className="ns-kpi">$24,680</span>
              <span className="text-[13px] font-semibold" style={{ color: "#16A36B" }}>+18.4%</span>
              <span className="ns-body">Monthly revenue</span>
            </div>
            <BarChart data={REVENUE_MONTHS.map((m) => ({ label: m.month, value: m.value }))} colorA="#7357FF" />
          </div>
        </div>

        <div className="ns-card flex flex-col" style={{ background: "var(--ns-midnight)", borderColor: "var(--ns-midnight)" }}>
          <div className="p-5">
            <p className="ns-label" style={{ color: "#C7F36B" }}>Daily briefing</p>
            <h3 className="mt-1 text-[16px] font-bold text-white">Your next best move</h3>
            <p className="mt-3 text-[13px] leading-relaxed text-white/75">
              Pipeline is healthy, but two high-value opportunities have gone quiet. A short personal follow-up today
              could move $32,000 in potential revenue forward.
            </p>
          </div>
          <div className="mt-auto p-5 pt-0">
            <button className="ns-focus flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-[13px] font-semibold text-white" style={{ background: "#7357FF" }}>
              Ask for a plan <ArrowRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="ns-card">
          <SectionHeader eyebrow="Priority queue" title="Needs your attention" />
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {PRIORITY_QUEUE.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{item.title}</p>
                  <p className="ns-body truncate text-[12px]">{item.meta}</p>
                </div>
                <button className="ns-focus shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold" style={{ borderColor: "#E4E7EC", color: "#5B43D6" }}>
                  {item.cta}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="ns-card">
          <SectionHeader eyebrow="Workspace" title="Live activity" />
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {ACTIVITY_EVENTS.slice(0, 4).map((event) => {
              const cfg = ACTIVITY_ICON[event.tone];
              const Icon = cfg.icon;
              return (
                <li key={event.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
                    <Icon className="size-4" style={{ color: cfg.color }} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{event.title}</p>
                    <p className="ns-body truncate text-[12px]">{event.detail}</p>
                  </div>
                  <span className="shrink-0 text-[11px]" style={{ color: "#98A2B3" }}>{event.timestamp}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="ns-card">
        <SectionHeader eyebrow="Next 7 days" title="Upcoming work" />
        <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
          {UPCOMING_WORK.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <div>
                <p className="text-[13px] font-semibold" style={{ color: "#101828" }}>{item.title}</p>
                <p className="ns-body text-[12px]">{item.detail}</p>
              </div>
              <span className="text-[12px] font-semibold" style={{ color: "#667085" }}>{item.date}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
