import type { Lead } from "@/lib/workspace-demo-data";

export function Avatar({ name, color, size = 32 }: { name: string; color: string; size?: number }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white"
      style={{ width: size, height: size, background: color }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

export function LeadCard({ lead, onOpen }: { lead: Lead; onOpen: (lead: Lead) => void }) {
  return (
    <button
      onClick={() => onOpen(lead)}
      className="ns-card ns-focus flex w-full flex-col gap-2 p-3 text-left hover:shadow-[0_2px_8px_rgba(16,24,40,0.08)]"
      aria-label={`Open ${lead.name} at ${lead.company}`}
    >
      <div className="flex items-center gap-2">
        <Avatar name={lead.name} color={lead.avatarColor} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold" style={{ color: "#101828" }}>{lead.name}</p>
          <p className="truncate text-[12px]" style={{ color: "#667085" }}>{lead.company}</p>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px]" style={{ color: "#98A2B3" }}>
        <span className="font-semibold" style={{ color: "#16A36B" }}>{lead.match}% match</span>
        <span>{lead.lastTouch}</span>
      </div>
    </button>
  );
}

export default LeadCard;
