"use client";

import { useMemo, useState } from "react";
import { Plus, CalendarDays } from "lucide-react";
import { CONTENT_ITEMS, type ContentStatus } from "@/lib/workspace-demo-data";
import { StatusBadge, type StatusTone } from "@/components/workspace/StatusBadge";
import { MetricCard } from "@/components/workspace/MetricCard";
import { Megaphone, Activity as ActivityIcon, FileText } from "lucide-react";
import { EmptyState } from "@/components/workspace/EmptyState";

const STATUS_TONE: Record<ContentStatus, StatusTone> = {
  Scheduled: "violet",
  "In review": "orange",
  Published: "green",
  Draft: "gray",
};

const TABS: ("All content" | ContentStatus)[] = ["All content", "In review", "Scheduled", "Published"];

export default function CampaignsPage() {
  const [tab, setTab] = useState<"All content" | ContentStatus>("All content");

  const filtered = useMemo(
    () => CONTENT_ITEMS.filter((c) => tab === "All content" || c.status === tab),
    [tab]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="ns-title text-[24px]">Campaigns &amp; content</h1>
        <div className="flex gap-2">
          <button className="ns-focus flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-semibold" style={{ borderColor: "#E4E7EC", color: "#344054" }}>
            <CalendarDays className="size-4" aria-hidden /> Calendar view
          </button>
          <button className="ns-focus flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-white" style={{ background: "#7357FF" }}>
            <Plus className="size-4" aria-hidden /> New content
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Published reach" value="28.4k" context="This month" icon={Megaphone} />
        <MetricCard label="Engagement rate" value="6.8%" context="This month" trend="up" icon={ActivityIcon} />
        <MetricCard label="Assets in review" value="03" context="Needs approval" icon={FileText} />
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
          <EmptyState title="No content in this view." description="Try a different status filter." />
        ) : (
          <div className="ns-scrollbar overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-y" style={{ borderColor: "var(--ns-border)" }}>
                  {["Content item", "Channel", "Status", "Publish date", "Reach", ""].map((h) => (
                    <th key={h} className="ns-label px-5 py-3 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id} className="border-b transition-colors hover:bg-[#F7F8FC]" style={{ borderColor: "var(--ns-border)" }}>
                    <td className="px-5 py-3 font-semibold" style={{ color: "#101828" }}>{item.title}</td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{item.channel}</td>
                    <td className="px-5 py-3"><StatusBadge label={item.status} tone={STATUS_TONE[item.status]} /></td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{item.publishDate}</td>
                    <td className="px-5 py-3" style={{ color: "#667085" }}>{item.reach}</td>
                    <td className="px-5 py-3 text-right" style={{ color: "#98A2B3" }}>···</td>
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
