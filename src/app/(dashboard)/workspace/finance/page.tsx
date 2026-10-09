import { Wallet, Receipt, TrendingDown, Percent } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFinance, fmtMoney } from "@/lib/workspace-data";
import { MetricCard } from "@/components/workspace/MetricCard";
import { BarChart } from "@/components/workspace/BarChart";
import { EmptyState } from "@/components/workspace/EmptyState";

export default async function FinancePage() {
  const supabase = await createClient();
  const finance = await getWorkspaceFinance(supabase);

  return (
    <div className="space-y-6">
      <h1 className="ns-title text-[24px]">Finance</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Cash collected" value={fmtMoney(finance.cashCollected)} context="This month" trend="neutral" icon={Wallet} />
        <MetricCard label="Open proposals" value={fmtMoney(finance.openProposalsValue)} context={`${finance.openProposalsCount} awaiting a decision`} icon={Receipt} />
        <MetricCard label="Operating expenses" value={fmtMoney(finance.operatingExpenses)} context="This month" trend="neutral" icon={TrendingDown} />
        <MetricCard label="Net margin" value={finance.netMarginPct == null ? "—" : `${finance.netMarginPct.toFixed(1)}%`} context="This month" trend="neutral" icon={Percent} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="ns-card lg:col-span-2">
          <div className="flex items-start justify-between gap-3 p-5 pb-3">
            <div>
              <p className="ns-label mb-1">Cash flow</p>
              <h3 className="ns-section-title">Income vs. expenses</h3>
            </div>
          </div>
          <div className="px-5 pb-5">
            <BarChart
              data={finance.cashFlowMonths.map((m) => ({ label: m.month, value: m.income, valueB: m.expenses }))}
              colorA="#7357FF"
              colorB="#C7F36B"
              showLegend
              legendA="Income"
              legendB="Expenses"
            />
            <p className="mt-2 text-[11px]" style={{ color: "#98A2B3" }}>Last 6 months.</p>
          </div>
        </div>

        <div className="ns-card">
          <div className="p-5 pb-3">
            <h3 className="ns-section-title">Open proposals</h3>
          </div>
          {finance.openProposals.length === 0 ? (
            <EmptyState title="No open proposals." description="Proposals sent to leads will show up here while they await a decision." />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
              {finance.openProposals.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-5 py-3.5">
                  <div>
                    <p className="text-[13px] font-semibold" style={{ color: "#101828" }}>{p.client}</p>
                    <p className="text-[12px]" style={{ color: "#98A2B3" }}>Sent {new Date(p.sentAtISO).toLocaleDateString()}</p>
                  </div>
                  <span className="text-[13px] font-semibold" style={{ color: "#101828" }}>${p.amount.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
