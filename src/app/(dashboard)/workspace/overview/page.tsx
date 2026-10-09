import { DollarSign, Target, FolderKanban, CalendarCheck, CheckCircle2, Send, MoveRight, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceOverview, fmtMoney, relativeTime } from "@/lib/workspace-data";
import { MetricCard } from "@/components/workspace/MetricCard";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import { BarChart } from "@/components/workspace/BarChart";
import { EmptyState } from "@/components/workspace/EmptyState";

const ACTIVITY_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  success: { icon: CheckCircle2, color: "#16A36B" },
  info: { icon: Send, color: "#3485D8" },
  warning: { icon: Receipt, color: "#F08C46" },
  neutral: { icon: MoveRight, color: "#667085" },
};

const fmtPct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

export default async function OverviewPage() {
  const supabase = await createClient();
  const data = await getWorkspaceOverview(supabase);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="ns-label mb-2">{today}</p>
          <h1 className="ns-title">Overview</h1>
          <p className="ns-body mt-1">Here is what needs your attention today.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard
          label="Revenue this month"
          value={fmtMoney(data.revenueThisMonth)}
          context={data.revenueTrendPct == null ? "No revenue last month to compare" : `${fmtPct(data.revenueTrendPct)} vs last month`}
          trend={data.revenueTrendPct == null ? "neutral" : data.revenueTrendPct >= 0 ? "up" : "down"}
          icon={DollarSign}
        />
        <MetricCard label="Open proposal value" value={fmtMoney(data.openProposalsValue)} context="Awaiting a decision" trend="neutral" icon={Target} />
        <MetricCard label="Active projects" value={String(data.activeProjectsCount).padStart(2, "0")} context="Not yet delivered" trend="neutral" icon={FolderKanban} />
        <MetricCard label="Appointments upcoming" value={String(data.upcomingAppointments)} context="Scheduled meetings" trend="neutral" icon={CalendarCheck} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="ns-card lg:col-span-2">
          <SectionHeader eyebrow="Performance" title="Revenue overview" />
          <div className="px-5 pb-5">
            <div className="mb-4 flex items-baseline gap-3">
              <span className="ns-kpi">{fmtMoney(data.revenueThisMonth)}</span>
              {data.revenueTrendPct != null && (
                <span className="text-[13px] font-semibold" style={{ color: data.revenueTrendPct >= 0 ? "#16A36B" : "#F08C46" }}>
                  {fmtPct(data.revenueTrendPct)}
                </span>
              )}
              <span className="ns-body">Monthly revenue</span>
            </div>
            <BarChart data={data.revenueMonths.map((m) => ({ label: m.month, value: m.value }))} colorA="#7357FF" />
          </div>
        </div>

        <div className="ns-card flex flex-col" style={{ background: "var(--ns-midnight)", borderColor: "var(--ns-midnight)" }}>
          <div className="p-5">
            <p className="ns-label" style={{ color: "#C7F36B" }}>Snapshot</p>
            <h3 className="mt-1 text-[16px] font-bold text-white">What needs a decision</h3>
            <p className="mt-3 text-[13px] leading-relaxed text-white/75">
              {data.priorityQueue.length === 0
                ? "Nothing is waiting on you right now."
                : `${data.priorityQueue.length} item${data.priorityQueue.length === 1 ? "" : "s"} across blocked projects, pending budget requests, and overdue follow-ups need your attention.`}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="ns-card">
          <SectionHeader eyebrow="Priority queue" title="Needs your attention" />
          {data.priorityQueue.length === 0 ? (
            <EmptyState title="Nothing needs your attention." description="Blocked projects, pending budget requests, and overdue follow-ups will show up here." />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
              {data.priorityQueue.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{item.title}</p>
                    <p className="ns-body truncate text-[12px]">{item.meta}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ns-card">
          <SectionHeader eyebrow="Workspace" title="Live activity" />
          {data.recentActivity.length === 0 ? (
            <EmptyState title="No activity yet." description="Revenue, replies, bookings, and published content will show up here as they happen." />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
              {data.recentActivity.map((event) => {
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
                    <span className="shrink-0 text-[11px]" style={{ color: "#98A2B3" }}>{relativeTime(event.timestampISO)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="ns-card">
        <SectionHeader eyebrow="Next 7 days" title="Upcoming work" />
        {data.upcomingWork.length === 0 ? (
          <EmptyState title="Nothing scheduled in the next 7 days." description="Project deadlines and booked meetings will show up here." />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {data.upcomingWork.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div>
                  <p className="text-[13px] font-semibold" style={{ color: "#101828" }}>{item.title}</p>
                  <p className="ns-body text-[12px]">{item.detail}</p>
                </div>
                <span className="text-[12px] font-semibold" style={{ color: "#667085" }}>
                  {new Date(item.dateISO).toLocaleDateString(undefined, { month: "short", day: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
