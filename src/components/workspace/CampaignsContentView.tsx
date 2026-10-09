"use client";

import { useMemo, useState } from "react";
import type { WorkspaceContentItem, WorkspaceContentStatus } from "@/lib/workspace-data";
import { StatusBadge, type StatusTone } from "@/components/workspace/StatusBadge";
import { MetricCard } from "@/components/workspace/MetricCard";
import { Megaphone, FileClock, AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/workspace/EmptyState";

const STATUS_LABEL: Record<WorkspaceContentStatus, string> = {
  creating: "Creating",
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  failed: "Failed",
};

const STATUS_TONE: Record<WorkspaceContentStatus, StatusTone> = {
  creating: "blue",
  draft: "gray",
  scheduled: "violet",
  published: "green",
  failed: "orange",
};

const TABS: ("All content" | WorkspaceContentStatus)[] = ["All content", "draft", "scheduled", "published", "failed"];

export function CampaignsContentView({
  items,
  publishedThisMonth,
  draftsAwaiting,
  failedThisMonth,
}: {
  items: WorkspaceContentItem[];
  publishedThisMonth: number;
  draftsAwaiting: number;
  failedThisMonth: number;
}) {
  const [tab, setTab] = useState<"All content" | WorkspaceContentStatus>("All content");

  const filtered = useMemo(() => items.filter((c) => tab === "All content" || c.status === tab), [items, tab]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="ns-title text-[24px]">Campaigns &amp; content</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Published this month" value={String(publishedThisMonth)} context="Live posts" icon={Megaphone} />
        <MetricCard label="Drafts awaiting publish" value={String(draftsAwaiting)} context="Needs manual publish" icon={FileClock} />
        <MetricCard label="Failed this month" value={String(failedThisMonth)} context="Generation or publish errors" trend={failedThisMonth > 0 ? "down" : "neutral"} icon={AlertTriangle} />
      </div>

      <div className="ns-scrollbar flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="ns-focus shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium"
            style={tab === t ? { background: "rgba(115,87,255,0.1)", color: "#5B43D6" } : { color: "#667085" }}
          >
            {t === "All content" ? t : STATUS_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="ns-card">
        {filtered.length === 0 ? (
          <EmptyState title="No content in this view." description="Try a different status filter." />
        ) : (
          <div className="ns-scrollbar overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-y" style={{ borderColor: "var(--ns-border)" }}>
                  {["Content item", "Channel", "Status", "Publish date"].map((h) => (
                    <th key={h} className="ns-label px-5 py-3 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id} className="border-b transition-colors hover:bg-[#F7F8FC]" style={{ borderColor: "var(--ns-border)" }}>
                    <td className="px-5 py-3 font-semibold" style={{ color: "#101828" }}>{item.title}</td>
                    <td className="px-5 py-3 capitalize" style={{ color: "#667085" }}>{item.channel}</td>
                    <td className="px-5 py-3"><StatusBadge label={STATUS_LABEL[item.status]} tone={STATUS_TONE[item.status]} /></td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{item.publishDateISO ? new Date(item.publishDateISO).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default CampaignsContentView;
