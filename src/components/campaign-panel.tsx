"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import CampaignSendWindow from "@/components/campaign-send-window";
import CampaignTemplate from "@/components/campaign-template";

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

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-black/[.06] dark:bg-white/[.08]">
      <div className="h-1.5 rounded-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
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

  if (!campaign) {
    return (
      <div className="rounded-xl border border-black/[.08] dark:border-white/[.145] p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">No campaign this month</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Starting a campaign pulls fresh leads from Vibe Prospecting using your saved targeting (set in Business
            Profile), skips anyone you&apos;ve already contacted, and schedules up to 12 leads for outreach — sent
            gradually across your mailboxes each day.
          </p>
        </div>
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
    );
  }

  const leadsExhausted = campaign.status === "active" && campaign.sent_count >= campaign.eligible_leads && campaign.eligible_leads > 0;

  return (
    <div className="space-y-4">
      {/* Campaign header card */}
      <div className="rounded-xl border border-black/[.08] dark:border-white/[.145] p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{monthLabel(campaign.campaign_month)}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Campaign · {campaign.id.slice(0, 8)}</p>
          </div>
          <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASS[campaign.status] ?? ""}`}>
            {STATUS_LABEL[campaign.status] ?? campaign.status}
          </span>
        </div>

        {warning && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            {warning}
          </p>
        )}
        {campaign.status === "failed" && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            Failed to generate leads — check your Vibe Prospecting connection and Business Profile targeting, then retry.
          </p>
        )}
        {leadsExhausted && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            All eligible leads have been contacted. Go to <strong>Prospecting</strong> to find more leads for this campaign.
          </p>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {[
            { label: "Target", value: campaign.target_leads },
            { label: "Generated", value: campaign.generated_leads },
            { label: "Eligible", value: campaign.eligible_leads },
            { label: "Sent", value: campaign.sent_count },
            { label: "Replies", value: campaign.reply_count },
            { label: "Bookings", value: campaign.booking_count },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-black/[.06] dark:border-white/[.1] px-3 py-2.5 text-center"
            >
              <p className="text-xl font-semibold tabular-nums">{stat.value}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Send progress bar */}
        {campaign.eligible_leads > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-500">
              <span>Outreach progress</span>
              <span>{campaign.sent_count} / {campaign.eligible_leads} sent</span>
            </div>
            <ProgressBar value={campaign.sent_count} max={campaign.eligible_leads} />
          </div>
        )}

        {campaign.status === "failed" && (
          <button
            onClick={startCampaign}
            disabled={loading}
            className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            {loading ? "Retrying…" : "Retry campaign"}
          </button>
        )}
      </div>

      {/* Per-campaign settings */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide px-0.5">Campaign settings</p>
        <CampaignSendWindow campaignId={campaign.id} />
        <CampaignTemplate campaignId={campaign.id} />
      </div>
    </div>
  );
}
