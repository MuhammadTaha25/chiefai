"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AdCampaign, AdFinanceDecision } from "@/types/db";

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  declined: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  pending_human: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  approved_pending_manual_launch: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  generating: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  launched: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  live: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  paused: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function RequestFinanceButton({ adCampaignId, onDecided }: { adCampaignId: string; onDecided: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/ads-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ad_campaign_id: adCampaignId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      // The decision itself can succeed while the ad_campaigns.status write
      // fails (e.g. an invalid status value hitting the DB check constraint)
      // — that used to be silently swallowed here, refreshing the page with
      // no visible change and no error, which is exactly the "looks stuck"
      // symptom this was meant to fix.
      if (data.update_error) throw new Error(`Decision recorded but status update failed: ${data.update_error}`);
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={submit}
        disabled={loading}
        className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {loading ? "Asking Finance…" : "Send to Finance"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export default function AdFinanceTable({
  campaigns,
  decisions,
}: {
  campaigns: AdCampaign[];
  decisions: AdFinanceDecision[];
}) {
  const router = useRouter();

  const latestDecisionFor = (campaignId: string) =>
    decisions
      .filter((d) => d.ad_campaign_id === campaignId)
      .sort((a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime())[0];

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
            <th className="px-4 py-3 font-medium">Campaign</th>
            <th className="px-4 py-3 font-medium">Platform</th>
            <th className="px-4 py-3 font-medium">Objective</th>
            <th className="px-4 py-3 font-medium">Daily budget</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Finance reason</th>
            <th className="px-4 py-3 font-medium" />
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const decision = latestDecisionFor(c.id);
            const canSendToFinance = c.status === "draft" || c.status === "pending_finance" || c.status === "pending_human";
            return (
              <tr key={c.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                <td className="px-4 py-3">
                  <div>{c.campaign_name || "Untitled"}</div>
                  {/* The three ids a live Meta ad is actually made of — proof the
                      hierarchy exists, not just a campaign shell. */}
                  {(c.zernio_campaign_id || c.ad_set_id || c.ad_id) && (
                    <div className="mt-1 font-mono text-[10px] text-zinc-400">
                      {c.zernio_campaign_id ? `camp ${c.zernio_campaign_id}` : ""}
                      {c.ad_set_id ? ` · set ${c.ad_set_id}` : ""}
                      {c.ad_id ? ` · ad ${c.ad_id}` : ""}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 capitalize">{c.platform?.replace(/_/g, " ")}</td>
                <td className="px-4 py-3 text-zinc-500">
                  {(c.objective ?? "—").replace(/_/g, " ")}
                  {c.optimization_goal ? (
                    <span className="block text-[10px] text-zinc-400">{c.optimization_goal.replace(/_/g, " ")}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3">{c.daily_budget != null ? `$${Number(c.daily_budget).toLocaleString()}` : "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs capitalize ${STATUS_STYLES[c.status] ?? STATUS_STYLES.draft}`}>
                    {c.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-500">{decision?.reason || c.error_message || "—"}</td>
                <td className="px-4 py-3 text-right">
                  {canSendToFinance && <RequestFinanceButton adCampaignId={c.id} onDecided={() => router.refresh()} />}
                </td>
              </tr>
            );
          })}
          {campaigns.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                No ad campaigns yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
