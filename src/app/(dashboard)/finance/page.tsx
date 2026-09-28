import { createClient } from "@/lib/supabase/server";
import type { BudgetRequest, LedgerEntry } from "@/types/db";
import BudgetRequestsTable from "@/components/budget-requests-table";
import StatCard from "@/components/stat-card";

interface DepartmentBudget {
  id: string;
  department: string;
  current_budget: number;
}

export default async function FinancePage() {
  const supabase = await createClient();

  const [{ data: budgetRequests }, { data: ledger }, { data: departmentBudgets }] = await Promise.all([
    supabase
      .from("budget_requests")
      .select("*")
      .order("requested_at", { ascending: false })
      .returns<BudgetRequest[]>(),
    supabase
      .from("ledger_entries")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(100)
      .returns<LedgerEntry[]>(),
    supabase.from("department_budgets").select("id, department, current_budget").returns<DepartmentBudget[]>(),
  ]);

  const entries = ledger ?? [];
  const revenue = entries.filter((e) => e.entry_type === "revenue").reduce((s, e) => s + Number(e.amount), 0);
  const expense = entries.filter((e) => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount), 0);

  const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Revenue (last 100 entries)" value={fmt(revenue)} />
        <StatCard label="Expenses (last 100 entries)" value={fmt(expense)} />
        <StatCard label="Net" value={fmt(revenue - expense)} />
      </div>

      <div>
        <h2 className="text-lg font-semibold">Department budgets</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(departmentBudgets ?? []).map((d) => (
            <StatCard key={d.id} label={d.department} value={fmt(Number(d.current_budget))} />
          ))}
          {(!departmentBudgets || departmentBudgets.length === 0) && (
            <p className="col-span-full text-sm text-zinc-500">No department budgets yet.</p>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Budget requests</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Simulates a department (e.g. marketing) asking Finance for more spend. The decision runs
          instantly against the <code>decide_budget_request</code> agent — approved requests top up
          the department budget, declines zero it out (the signal ad automation should watch for to
          auto-pause).
        </p>
        <BudgetRequestsTable requests={budgetRequests ?? []} />
      </div>

      <div>
        <h2 className="text-lg font-semibold">Ledger</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                  <td className="px-4 py-3 text-zinc-500">{new Date(e.occurred_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 capitalize">{e.entry_type}</td>
                  <td className="px-4 py-3">{e.category || "—"}</td>
                  <td className="px-4 py-3">{e.description || "—"}</td>
                  <td className={`px-4 py-3 text-right font-medium ${e.entry_type === "revenue" ? "text-green-600" : "text-red-600"}`}>
                    {e.entry_type === "revenue" ? "+" : "-"}
                    {fmt(Number(e.amount))}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No ledger entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
