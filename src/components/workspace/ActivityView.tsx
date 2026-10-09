"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Send, MoveRight, Receipt } from "lucide-react";
import type { WorkspaceActivityEvent, WorkspaceActivityCategory } from "@/lib/workspace-data";
import { relativeTime } from "@/lib/workspace-data";
import { EmptyState } from "@/components/workspace/EmptyState";

const TABS: ("All activity" | WorkspaceActivityCategory)[] = ["All activity", "Revenue", "Projects", "Leads", "Content"];

const ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  success: { icon: CheckCircle2, color: "#16A36B" },
  info: { icon: Send, color: "#3485D8" },
  warning: { icon: Receipt, color: "#F08C46" },
  neutral: { icon: MoveRight, color: "#667085" },
};

export function ActivityView({ events }: { events: WorkspaceActivityEvent[] }) {
  const [tab, setTab] = useState<"All activity" | WorkspaceActivityCategory>("All activity");

  const filtered = useMemo(() => events.filter((e) => tab === "All activity" || e.category === tab), [events, tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="ns-title text-[24px]">Activity</h1>
      </div>

      <div className="ns-scrollbar flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="ns-focus shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium"
            style={tab === t ? { background: "rgba(115,87,255,0.1)", color: "#5B43D6" } : { color: "#667085" }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="ns-card">
        {filtered.length === 0 ? (
          <EmptyState title="No activity yet." description="Your workspace activity will appear here as work moves forward." />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {filtered.map((event) => {
              const cfg = ICON[event.tone];
              const Icon = cfg.icon;
              return (
                <li key={event.id} className="flex items-center gap-3 px-5 py-4">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
                    <Icon className="size-4" style={{ color: cfg.color }} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold" style={{ color: "#101828" }}>{event.title}</p>
                    <p className="ns-body text-[12px]">{event.detail}</p>
                  </div>
                  <span className="shrink-0 text-[11px]" style={{ color: "#98A2B3" }}>{relativeTime(event.timestampISO)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default ActivityView;
