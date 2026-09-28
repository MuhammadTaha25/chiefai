import { createClient } from "@/lib/supabase/server";
import { getCurrentClient } from "@/lib/get-current-client";
import AdsPanel from "@/components/ads-panel";
import AdFinanceTable from "@/components/ad-finance-table";
import type { AdCampaign, AdFinanceDecision } from "@/types/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { listZernioAccounts, type ZernioAccountInfo } from "@/lib/zernio";

interface AdJob {
  id: string;
  platform: string;
  status: string;
  brief: Record<string, unknown> | null;
  audit_status: string | null;
  recommended_action: string | null;
  external_campaign_id?: string | null;
  external_ad_group_id?: string | null;
  external_ad_id?: string | null;
  last_error?: string | null;
  created_at: string;
}
interface SocialConnection {
  platform: string;
  connection_status: string | null;
  zernio_account_id?: string | null;
}

const ADS_PLATFORMS = ["facebook_ads", "instagram_ads", "google_ads"];

export default async function AdsPage() {
  const supabase = await createClient();
  const { client } = await getCurrentClient();

  const [
    { data: jobs, error: jobsError },
    { data: connections },
    { data: campaigns, error: campaignsError },
    { data: decisions },
  ] = await Promise.all([
    supabase.from("ad_generation_jobs").select("*").order("created_at", { ascending: false }).returns<AdJob[]>(),
    supabase.from("social_connections").select("platform, connection_status, zernio_account_id").returns<SocialConnection[]>(),
    supabase.from("ad_campaigns").select("*").order("created_at", { ascending: false }).returns<AdCampaign[]>(),
    supabase.from("ad_finance_decisions").select("*").order("decided_at", { ascending: false }).returns<AdFinanceDecision[]>(),
  ]);

  // The database only remembers that a connection was made once. Zernio is the
  // source of truth for whether it still exists, so an ads connection is shown
  // as "Connected" only if Zernio still holds that account (and, for Meta, an
  // ad account under it). If Zernio can't be reached we keep the stored state
  // rather than mark anything dead on a network blip.
  const [metaAccounts, igAccounts] = await Promise.all([
    listZernioAccounts("google_meta"),
    listZernioAccounts("tiktok_instagram"),
  ]);
  const verified: SocialConnection[] = [];
  const staleIds: string[] = [];
  for (const c of connections ?? []) {
    if (!ADS_PLATFORMS.includes(c.platform) || c.connection_status !== "connected" || !c.zernio_account_id) {
      verified.push(c);
      continue;
    }
    const list: ZernioAccountInfo[] | null = c.platform === "instagram_ads" ? igAccounts : metaAccounts;
    if (list === null) {
      verified.push(c);
      continue;
    }
    const found = list.find((a) => a.id === c.zernio_account_id);
    if (!found) {
      staleIds.push(c.zernio_account_id);
      verified.push({ ...c, connection_status: "disconnected" });
    } else if (c.platform !== "google_ads" && !found.adAccountId) {
      verified.push({ ...c, connection_status: "no_ad_account" });
    } else {
      verified.push(c);
    }
  }
  if (staleIds.length > 0) {
    // Best-effort: make the stored state truthful for the backend routes too.
    try {
      await createAdminClient()
        .from("social_connections")
        .update({ connection_status: "disconnected" })
        .in("zernio_account_id", staleIds)
        .in("platform", ADS_PLATFORMS);
    } catch {
      // The page still renders the truthful status even if the write fails.
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Ads</h1>
      {jobsError && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Ad job history isn&apos;t available yet — run the <code>ad_generation_jobs</code> migration
          (supabase/ad_generation_jobs.sql) in Supabase to enable it.
        </p>
      )}
      <AdsPanel
        jobs={jobs ?? []}
        connections={verified}
        googleAdsCustomerId={client?.google_ads_customer_id ?? null}
        campaigns={campaigns ?? []}
      />

      <div>
        <h2 className="text-lg font-semibold">Ad campaigns & Finance gate</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Once an ad passes audit it needs Finance approval before it can spend. The first ad for a
          client is auto-approved; every ad after that is gated on the prior ad&apos;s synced
          performance (<code>ad_performance.is_good</code>).
        </p>
        {campaignsError && (
          <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Finance ledger tables aren&apos;t available yet — run{" "}
            <code>supabase/ad_finance_ledger.sql</code> in Supabase to enable this.
          </p>
        )}
        <div className="mt-3">
          <AdFinanceTable campaigns={campaigns ?? []} decisions={decisions ?? []} />
        </div>
      </div>
    </div>
  );
}
