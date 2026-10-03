"use client";

import { X, Mail } from "lucide-react";
import type { Lead } from "@/lib/workspace-demo-data";
import { Avatar } from "./LeadCard";
import { StatusBadge } from "./StatusBadge";

const STAGE_TONE = { New: "blue", Contacted: "gray", Qualified: "violet", Proposal: "green" } as const;

const TIMELINE = [
  { id: "t1", label: "Email opened", when: "2 hours ago" },
  { id: "t2", label: "Visited pricing page", when: "1 day ago" },
  { id: "t3", label: "Added to pipeline", when: "6 days ago" },
];

export function LeadDrawer({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  if (!lead) return null;

  return (
    <>
      <button
        aria-label="Close lead details"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/20"
      />
      <aside
        className="ns-root fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l shadow-2xl"
        style={{ background: "var(--ns-white)", borderColor: "var(--ns-border)" }}
        role="dialog"
        aria-label={`${lead.name} details`}
      >
        <div className="flex items-center justify-between border-b p-5" style={{ borderColor: "var(--ns-border)" }}>
          <p className="ns-section-title">Lead details</p>
          <button
            aria-label="Close"
            onClick={onClose}
            className="ns-focus grid size-8 place-items-center rounded-full hover:bg-[#F1F3F7]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="ns-scrollbar flex-1 overflow-y-auto p-5">
          <div className="flex items-center gap-3">
            <Avatar name={lead.name} color={lead.avatarColor} size={48} />
            <div>
              <p className="text-[16px] font-semibold" style={{ color: "#101828" }}>{lead.name}</p>
              <p className="ns-body">{lead.role} · {lead.company}</p>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-3 text-[12px]">
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Match score</dt>
              <dd className="font-semibold" style={{ color: "#16A36B" }}>{lead.match}%</dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Stage</dt>
              <dd><StatusBadge label={lead.stage} tone={STAGE_TONE[lead.stage]} /></dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Source</dt>
              <dd className="font-medium" style={{ color: "#101828" }}>{lead.source}</dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Last touch</dt>
              <dd className="font-medium" style={{ color: "#101828" }}>{lead.lastTouch}</dd>
            </div>
          </dl>

          <button className="ns-focus mt-4 flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-semibold text-white" style={{ background: "#7357FF" }}>
            <Mail className="size-4" aria-hidden /> Email lead
          </button>

          <div className="mt-5 rounded-xl p-4" style={{ background: "#F1F3F7" }}>
            <p className="text-[12px] font-semibold" style={{ color: "#101828" }}>Send a personal follow-up</p>
            <p className="mt-1 text-[12px]" style={{ color: "#667085" }}>
              Reference their recent product launch and offer a 20-minute strategy review.
            </p>
          </div>

          <div className="mt-6">
            <p className="ns-label mb-3">Activity timeline</p>
            <ul className="space-y-3 border-l pl-4" style={{ borderColor: "var(--ns-border)" }}>
              {TIMELINE.map((t) => (
                <li key={t.id} className="relative text-[12px]">
                  <span
                    className="absolute -left-[21px] top-1 size-2 rounded-full"
                    style={{ background: "#7357FF" }}
                    aria-hidden
                  />
                  <p className="font-medium" style={{ color: "#101828" }}>{t.label}</p>
                  <p style={{ color: "#98A2B3" }}>{t.when}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    </>
  );
}

export default LeadDrawer;
