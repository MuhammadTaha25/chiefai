import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { formatLocalDateTime } from "@/lib/format-date";

interface LeadGenJob {
  id: string;
  status: string;
  criteria: { what_you_sell?: string; ai_analysis?: { summary?: string } };
  leads_found: number | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "text-zinc-500" },
  analyzed: { label: "Analyzed", color: "text-amber-600" },
  completed: { label: "Completed", color: "text-green-600" },
  error: { label: "Error", color: "text-red-600" },
  blocked_missing_prospecting_key: { label: "Needs prospecting key", color: "text-amber-600" },
};

export default async function ProspectingPage() {
  const supabase = await createClient();
  const exploriumConfigured = Boolean(process.env.EXPLORIUM_API_KEY);

  const { data: jobs } = await supabase
    .from("lead_gen_jobs")
    .select("id, status, criteria, leads_found, last_error, created_at")
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<LeadGenJob[]>();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">AI Prospecting</h1>
      <p className="text-sm text-zinc-500">
        Every submission from <Link href="/lead-gen" className="underline">Find leads</Link> runs here: Gemini
        turns your answers into a structured ICP, then sources matching leads automatically.
      </p>

      {!exploriumConfigured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Prospecting isn&apos;t live yet.</strong> Gemini can already analyze your criteria, but sourcing
          actual leads needs an Explorium API key. Sign up at{" "}
          <a href="https://explorium.ai" target="_blank" rel="noreferrer" className="underline">
            explorium.ai
          </a>{" "}
          and add <code className="rounded bg-black/[.06] px-1 dark:bg-white/[.1]">EXPLORIUM_API_KEY</code> to{" "}
          <code className="rounded bg-black/[.06] px-1 dark:bg-white/[.1]">.env.local</code>.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
              <th className="px-4 py-3 font-medium">Submitted</th>
              <th className="px-4 py-3 font-medium">What they&apos;re selling</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Leads found</th>
            </tr>
          </thead>
          <tbody>
            {(jobs ?? []).map((job) => {
              const status = STATUS_LABEL[job.status] ?? { label: job.status, color: "text-zinc-500" };
              return (
                <tr key={job.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                  <td className="px-4 py-3 text-zinc-500">{formatLocalDateTime(job.created_at)}</td>
                  <td className="px-4 py-3 max-w-md truncate" title={job.criteria.what_you_sell}>
                    {job.criteria.ai_analysis?.summary || job.criteria.what_you_sell || "—"}
                  </td>
                  <td className={`px-4 py-3 font-medium ${status.color}`} title={job.last_error ?? undefined}>
                    {status.label}
                  </td>
                  <td className="px-4 py-3">{job.leads_found ?? "—"}</td>
                </tr>
              );
            })}
            {(!jobs || jobs.length === 0) && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                  No prospecting jobs yet — submit the{" "}
                  <Link href="/lead-gen" className="underline">
                    Find leads
                  </Link>{" "}
                  form to start one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
