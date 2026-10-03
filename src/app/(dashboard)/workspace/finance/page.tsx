"use client";

import { useState } from "react";
import { Wallet, Receipt, TrendingDown, Percent } from "lucide-react";
import { MetricCard } from "@/components/workspace/MetricCard";
import { BarChart } from "@/components/workspace/BarChart";
import { OUTSTANDING_INVOICES, CASH_FLOW_MONTHS } from "@/lib/workspace-demo-data";

const PERIODS = ["Last 6 months", "This quarter", "Year to date"];

export default function FinancePage() {
  const [period, setPeriod] = useState(PERIODS[0]);

  return (
    <div className="space-y-6">
      <h1 className="ns-title text-[24px]">Finance</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Cash collected" value="$31,240" context="This month" trend="up" icon={Wallet} />
        <MetricCard label="Outstanding invoices" value="$12,860" context="4 open invoices" icon={Receipt} />
        <MetricCard label="Operating expenses" value="$8,420" context="This month" trend="down" icon={TrendingDown} />
        <MetricCard label="Net margin" value="48.6%" context="This month" trend="up" icon={Percent} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="ns-card lg:col-span-2">
          <div className="flex items-start justify-between gap-3 p-5 pb-3">
            <div>
              <p className="ns-label mb-1">Cash flow</p>
              <h3 className="ns-section-title">Income vs. expenses</h3>
            </div>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              aria-label="Select period"
              className="ns-focus rounded-full border px-3 py-1.5 text-[12px] font-medium"
              style={{ borderColor: "#E4E7EC", color: "#344054" }}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="px-5 pb-5">
            <BarChart
              data={CASH_FLOW_MONTHS.map((m) => ({ label: m.month, value: m.income, valueB: m.expenses }))}
              colorA="#7357FF"
              colorB="#C7F36B"
              showLegend
              legendA="Income"
              legendB="Expenses"
            />
            <p className="mt-2 text-[11px]" style={{ color: "#98A2B3" }}>Showing {period.toLowerCase()}.</p>
          </div>
        </div>

        <div className="ns-card">
          <div className="p-5 pb-3">
            <h3 className="ns-section-title">Outstanding invoices</h3>
          </div>
          <ul className="divide-y" style={{ borderColor: "var(--ns-border)" }}>
            {OUTSTANDING_INVOICES.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between px-5 py-3.5">
                <div>
                  <p className="text-[13px] font-semibold" style={{ color: "#101828" }}>{inv.client}</p>
                  <p className="text-[12px]" style={{ color: inv.urgent ? "#F08C46" : "#98A2B3" }}>{inv.due}</p>
                </div>
                <span className="text-[13px] font-semibold" style={{ color: "#101828" }}>
                  ${inv.amount.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
