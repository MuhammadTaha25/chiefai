"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Campaign {
  id: string;
  client_id: string;
  campaign_month: string;
  status: string;
  target_leads: number;
  generated_leads: number;
  eligible_leads: number;
  sent_count: number;
  reply_count: number;
  booking_count: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Starting…",
  active: "Active",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  active: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  completed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

function monthLabel(campaignMonth: string) {
  return new Date(campaignMonth + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function CampaignPanel({ campaign: initialCampaign }: { campaign: Campaign | null }) {
  const router = useRouter();
  const [campaign, setCampaign] = useState(initialCampaign);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function startCampaign() {
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch("/api/campaigns/create", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start this month's campaign");
      setCampaign(data.campaign);
      if (data.warning) setWarning(data.warning);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel panel-body space-y-4">
      {!campaign ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">
            No campaign started for this month yet. Starting one pulls fresh leads from Vibe Prospecting using your
            saved targeting (set in Business Profile), skips anyone you&apos;ve already contacted, and schedules up to
            12 leads for outreach — 4 initial emails a day, rotated across your mailboxes.
          </p>
          {error && (
            <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>
          )}
          <button
            onClick={startCampaign}
            disabled={loading}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Starting…" : "Start this month's campaign"}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">{monthLabel(campaign.campaign_month)}</h2>
              {warning && <p className="mt-1 text-sm text-amber-600">{warning}</p>}
              {campaign.status === "failed" && (
                <p className="mt-1 text-sm text-red-600">
                  This campaign failed to generate leads — check Vibe Prospecting connection and your saved targeting
                  in Business Profile, then try again.
                </p>
              )}
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASS[campaign.status] ?? ""}`}>
              {STATUS_LABEL[campaign.status] ?? campaign.status}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {[
              { label: "Target", value: campaign.target_leads },
              { label: "Generated", value: campaign.generated_leads },
              { label: "Eligible", value: campaign.eligible_leads },
              { label: "Sent", value: campaign.sent_count },
              { label: "Replies", value: campaign.reply_count },
              { label: "Bookings", value: campaign.booking_count },
            ].map((stat) => (
              <div key={stat.label} className="rounded-md border border-black/[.08] px-3 py-2 text-center dark:border-white/[.145]">
                <p className="text-lg font-semibold">{stat.value}</p>
                <p className="text-xs text-zinc-500">{stat.label}</p>
              </div>
            ))}
          </div>

          {campaign.status === "failed" && (
            <button
              onClick={startCampaign}
              disabled={loading}
              className="rounded-md border border-black/[.08] px-4 py-2 text-sm font-medium hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
