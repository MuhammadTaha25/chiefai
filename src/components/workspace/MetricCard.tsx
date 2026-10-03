import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

export interface MetricCardProps {
  label: string;
  value: string;
  context: string;
  trend?: "up" | "down" | "neutral";
  icon: LucideIcon;
}

export function MetricCard({ label, value, context, trend = "neutral", icon: Icon }: MetricCardProps) {
  const trendColor = trend === "up" ? "#16A36B" : trend === "down" ? "#F08C46" : "#667085";
  return (
    <div
      tabIndex={0}
      className="ns-card ns-focus flex flex-col gap-3 p-5 transition-shadow hover:shadow-[0_1px_2px_rgba(16,24,40,0.04),0_4px_12px_rgba(16,24,40,0.06)]"
    >
      <div className="flex items-center justify-between">
        <span className="ns-label">{label}</span>
        <span className="grid size-8 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
          <Icon className="size-4" style={{ color: "#7357FF" }} aria-hidden />
        </span>
      </div>
      <span className="ns-kpi">{value}</span>
      <div className="flex items-center gap-1 text-[12px] font-medium" style={{ color: trendColor }}>
        {trend === "up" && <ArrowUpRight className="size-3.5" aria-hidden />}
        {trend === "down" && <ArrowDownRight className="size-3.5" aria-hidden />}
        <span>{context}</span>
      </div>
    </div>
  );
}

export default MetricCard;
