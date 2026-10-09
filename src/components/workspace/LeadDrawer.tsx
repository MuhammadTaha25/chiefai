"use client";

import { X, Mail } from "lucide-react";
import type { WorkspaceLead } from "@/lib/workspace-data";
import { STAGE_LABEL, avatarColorFor, relativeTime } from "@/lib/workspace-data";
import { Avatar } from "./LeadCard";
import { StatusBadge } from "./StatusBadge";

const STAGE_TONE = { sent: "blue", negotiation: "violet", won: "green", lost: "gray" } as const;

export function LeadDrawer({ lead, onClose }: { lead: WorkspaceLead | null; onClose: () => void }) {
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
            <Avatar name={lead.name} color={avatarColorFor(lead.name)} size={48} />
            <div>
              <p className="text-[16px] font-semibold" style={{ color: "#101828" }}>{lead.name}</p>
              <p className="ns-body">{lead.role || "—"} · {lead.company}</p>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-3 text-[12px]">
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Deal value</dt>
              <dd className="font-semibold" style={{ color: "#101828" }}>{lead.amount != null ? `$${lead.amount.toLocaleString()}` : "—"}</dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Stage</dt>
              <dd><StatusBadge label={STAGE_LABEL[lead.stage]} tone={STAGE_TONE[lead.stage]} /></dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Source</dt>
              <dd className="font-medium" style={{ color: "#101828" }}>{lead.source}</dd>
            </div>
            <div className="ns-card p-3">
              <dt className="ns-label mb-1">Last touch</dt>
              <dd className="font-medium" style={{ color: "#101828" }}>{relativeTime(lead.lastTouchISO)}</dd>
            </div>
          </dl>

          <div className="mt-5 rounded-xl p-4" style={{ background: "#F1F3F7" }}>
            <p className="text-[12px] font-semibold" style={{ color: "#101828" }}>{lead.stageDetail}</p>
          </div>

          <a
            href="/leads"
            className="ns-focus mt-4 flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-semibold text-white"
            style={{ background: "#7357FF" }}
          >
            <Mail className="size-4" aria-hidden /> Open in Leads
          </a>
        </div>
      </aside>
    </>
  );
}

export default LeadDrawer;
