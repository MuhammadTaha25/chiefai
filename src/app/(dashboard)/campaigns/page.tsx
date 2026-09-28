import { createClient } from "@/lib/supabase/server";
import CampaignPanel from "@/components/campaign-panel";

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
  created_at: string;
}

function currentCampaignMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export default async function CampaignsPage() {
  const supabase = await createClient();

  const campaignMonth = currentCampaignMonth();

  const [{ data: currentCampaign }, { data: history }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads, sent_count, reply_count, booking_count, created_at")
      .eq("campaign_month", campaignMonth)
      .maybeSingle<Campaign>(),
    supabase
      .from("campaigns")
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads, sent_count, reply_count, booking_count, created_at")
      .neq("campaign_month", campaignMonth)
      .order("campaign_month", { ascending: false })
      .returns<Campaign[]>(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="mt-1 text-sm text-zinc-500">
          One monthly outreach cycle — fresh leads from Vibe Prospecting, deduplicated against everyone you&apos;ve
          already contacted, sent gradually with a daily limit.
        </p>
      </div>

      <CampaignPanel campaign={currentCampaign ?? null} />

      {history && history.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold">Previous months</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                  <th className="px-4 py-3 font-medium">Month</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Generated</th>
                  <th className="px-4 py-3 font-medium">Sent</th>
                  <th className="px-4 py-3 font-medium">Replies</th>
                  <th className="px-4 py-3 font-medium">Bookings</th>
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                    <td className="px-4 py-3">
                      {new Date(c.campaign_month + "T00:00:00Z").toLocaleDateString(undefined, {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td className="px-4 py-3 capitalize">{c.status}</td>
                    <td className="px-4 py-3">{c.generated_leads}</td>
                    <td className="px-4 py-3">{c.sent_count}</td>
                    <td className="px-4 py-3">{c.reply_count}</td>
                    <td className="px-4 py-3">{c.booking_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
