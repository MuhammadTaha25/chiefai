import { createClient } from "@/lib/supabase/server";
import StatCard from "@/components/stat-card";
import AskCompany from "@/components/ask-company";
import OutreachPipeline from "@/components/outreach-pipeline";
import { getOutreachStatus } from "@/lib/outreach-status";
import { formatLocalDateTime } from "@/lib/format-date";

interface AdFinanceDecisionRow {
  decision: string;
  reason: string | null;
  decided_at: string;
}

interface AdPerformanceRow {
  spend: number | null;
  ctr: number | null;
  cpl: number | null;
  is_good: boolean | null;
  synced_at: string;
}

interface AdCampaignRow {
  id: string;
  platform: string;
  objective: string | null;
  requested_budget: number | null;
  status: string;
  created_at: string;
  ad_finance_decisions: AdFinanceDecisionRow[] | null;
  ad_performance: AdPerformanceRow[] | null;
}

interface AdGenerationJobRow {
  id: string;
  platform: string;
  status: string;
  audit_status: string | null;
  audit_ctr: number | null;
  audit_cpa: number | null;
  recommended_action: string | null;
  audited_at: string | null;
  previous_job_id: string | null;
}

interface AutomationSettingRow {
  client_id: string;
  platform: string;
  posts_per_week: number;
  stories_per_week: number;
  stories_enabled: boolean;
}

function startOfUtcWeek(d: Date): Date {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function latestBy<T>(rows: T[] | null, dateKey: keyof T): T | null {
  if (!rows || rows.length === 0) return null;
  return [...rows].sort(
    (a, b) => new Date(b[dateKey] as unknown as string).getTime() - new Date(a[dateKey] as unknown as string).getTime()
  )[0];
}

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: currentClientRow } = user
    ? await supabase.from("clients").select("id").eq("auth_user_id", user.id).maybeSingle()
    : { data: null };

  const outreachStatus = currentClientRow ? await getOutreachStatus(supabase, currentClientRow.id) : null;

  const now = new Date();
  const weekStart = startOfUtcWeek(now).toISOString();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const [
    { count: upcomingBookings },
    { data: campaigns },
    { data: auditJobs },
    { data: automationSettings },
    { data: postsThisWeek },
    { data: outreachToday },
    { data: leadSentiments },
  ] = await Promise.all([
    // Tenant-scoped (RLS) count. The old chief_of_staff_summary view aggregated ALL tenants and leaked their totals.
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("booking_status", "scheduled").gte("scheduled_at", now.toISOString()),
    supabase
      .from("ad_campaigns")
      .select("id, platform, objective, requested_budget, status, created_at, ad_finance_decisions(decision, reason, decided_at), ad_performance(spend, ctr, cpl, is_good, synced_at)")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<AdCampaignRow[]>(),
    supabase
      .from("ad_generation_jobs")
      .select("id, platform, status, audit_status, audit_ctr, audit_cpa, recommended_action, audited_at, previous_job_id")
      .not("audit_status", "is", null)
      .order("audited_at", { ascending: false })
      .limit(20)
      .returns<AdGenerationJobRow[]>(),
    supabase
      .from("social_automation_settings")
      .select("client_id, platform, posts_per_week, stories_per_week, stories_enabled")
      .returns<AutomationSettingRow[]>(),
    supabase
      .from("social_posts")
      .select("platform, content_type, published_at")
      .gte("published_at", weekStart)
      .returns<{ platform: string; content_type: string | null; published_at: string | null }[]>(),
    supabase
      .from("outreach_log")
      .select("touch_number, sent_at")
      .gte("sent_at", todayStart)
      .returns<{ touch_number: number; sent_at: string }[]>(),
    supabase.from("leads").select("sentiment, reply_received, created_at, last_contact_at").limit(5000).returns<{ sentiment: string | null; reply_received: boolean | null; created_at: string; last_contact_at: string | null }[]>(),
  ]);

  const fmtMoney = (n: number | null | undefined) =>
    n == null ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const leadsThisWeek = (leadSentiments ?? []).filter((l) => l.created_at >= weekStart).length;
  const leadsThisMonth = (leadSentiments ?? []).filter((l) => l.created_at >= monthStart).length;
  const contactedCount = (leadSentiments ?? []).filter((l) => l.last_contact_at).length;

  const emailsSentToday = (outreachToday ?? []).filter((o) => o.touch_number === 1).length;
  const followUpsSentToday = (outreachToday ?? []).filter((o) => o.touch_number > 1).length;
  const responsesReceived = (leadSentiments ?? []).filter((l) => l.reply_received).length;

  const sentimentCounts = (leadSentiments ?? []).reduce<Record<string, number>>((acc, l) => {
    if (!l.sentiment) return acc;
    acc[l.sentiment] = (acc[l.sentiment] ?? 0) + 1;
    return acc;
  }, {});

  const postingCompliance = (automationSettings ?? []).map((setting) => {
    const platformPosts = (postsThisWeek ?? []).filter((p) => p.platform === setting.platform);
    const postsCount = platformPosts.filter((p) => p.content_type !== "story").length;
    const storiesCount = platformPosts.filter((p) => p.content_type === "story").length;
    return {
      platform: setting.platform,
      postsCount,
      postsTarget: setting.posts_per_week,
      storiesCount,
      storiesTarget: setting.stories_enabled ? setting.stories_per_week : null,
    };
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Leads this week" value={leadsThisWeek} />
        <StatCard label="Leads this month" value={leadsThisMonth} />
        <StatCard label="Contacted" value={contactedCount} />
        <StatCard label="Replied" value={(leadSentiments ?? []).filter((l) => l.reply_received).length} />
        <StatCard label="Appointments upcoming" value={upcomingBookings ?? 0} />
      </div>

      <OutreachPipeline status={outreachStatus} />

      <div>
        <h2 className="text-lg font-semibold">Lead nurture (today)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Daily summary from the outreach cron — 5 new leads/day target, up to 3 follow-ups per
          non-responder (ZERNIO_META_ADS_SPEC.md §7).
        </p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Emails sent today" value={emailsSentToday} />
          <StatCard label="Follow-ups sent today" value={followUpsSentToday} />
          <StatCard label="Responses received" value={responsesReceived} />
          <StatCard label="Booking-interested" value={sentimentCounts.booking ?? 0} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Positive" value={sentimentCounts.positive ?? 0} />
          <StatCard label="Angry" value={sentimentCounts.angry ?? 0} />
          <StatCard label="Responded (neutral)" value={sentimentCounts.responded ?? 0} />
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Posting &amp; story compliance (this week)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Targets are your saved preferences. Automatic posting is not available yet, so counts only reflect posts recorded for your connected accounts.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Posts (published / target)</th>
                <th className="px-4 py-3 font-medium">Stories (published / target)</th>
              </tr>
            </thead>
            <tbody>
              {postingCompliance.map((row) => (
                <tr key={row.platform} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08] capitalize">
                  <td className="px-4 py-3">{row.platform}</td>
                  <td className={`px-4 py-3 ${row.postsCount < row.postsTarget ? "text-amber-600" : row.postsCount > row.postsTarget ? "text-red-600" : "text-green-600"}`}>
                    {row.postsCount} / {row.postsTarget}
                  </td>
                  <td className="px-4 py-3">
                    {row.storiesTarget == null ? (
                      <span className="text-zinc-500 normal-case">Stories disabled</span>
                    ) : (
                      <span className={row.storiesCount < row.storiesTarget ? "text-amber-600" : row.storiesCount > row.storiesTarget ? "text-red-600" : "text-green-600"}>
                        {row.storiesCount} / {row.storiesTarget}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {postingCompliance.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-zinc-500">
                    No social automation configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Ad campaigns — audit &amp; finance history</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Objective</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Finance decision</th>
                <th className="px-4 py-3 text-right font-medium">Spend / CTR / CPL</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns ?? []).map((c) => {
                const decision = latestBy<AdFinanceDecisionRow>(c.ad_finance_decisions, "decided_at");
                const perf = latestBy<AdPerformanceRow>(c.ad_performance, "synced_at");
                return (
                  <tr key={c.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                    <td className="px-4 py-3 capitalize">{c.platform}</td>
                    <td className="px-4 py-3">{c.objective || "—"}</td>
                    <td className="px-4 py-3 capitalize">{c.status}</td>
                    <td className="px-4 py-3">
                      {decision ? (
                        <span
                          className={
                            decision.decision === "approved"
                              ? "text-green-600"
                              : decision.decision === "rejected"
                              ? "text-red-600"
                              : "text-amber-600"
                          }
                          title={decision.reason ?? undefined}
                        >
                          {decision.decision}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {perf
                        ? `${fmtMoney(perf.spend)} / ${perf.ctr ?? "—"} / ${perf.cpl ?? "—"}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
              {(!campaigns || campaigns.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No ad campaigns yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Recent ad audits</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Each row is one audit pass from the ad-generation workflow. A job chained to a{" "}
          <code>previous_job_id</code> is a revision that ran after a prior audit came back{" "}
          <code>needs_fix</code>.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Verdict</th>
                <th className="px-4 py-3 font-medium">CTR / CPA</th>
                <th className="px-4 py-3 font-medium">Recommended action</th>
                <th className="px-4 py-3 font-medium">Revision</th>
                <th className="px-4 py-3 font-medium">Audited</th>
              </tr>
            </thead>
            <tbody>
              {(auditJobs ?? []).map((j) => (
                <tr key={j.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                  <td className="px-4 py-3 capitalize">{j.platform}</td>
                  <td className={`px-4 py-3 ${j.audit_status === "good" ? "text-green-600" : "text-amber-600"}`}>
                    {j.audit_status}
                  </td>
                  <td className="px-4 py-3">
                    {j.audit_ctr ?? "—"} / {j.audit_cpa ?? "—"}
                  </td>
                  <td className="px-4 py-3">{j.recommended_action || "—"}</td>
                  <td className="px-4 py-3">{j.previous_job_id ? "Revision" : "Original"}</td>
                  <td className="px-4 py-3 text-zinc-500">
                    {j.audited_at ? formatLocalDateTime(j.audited_at) : "—"}
                  </td>
                </tr>
              ))}
              {(!auditJobs || auditJobs.length === 0) && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No audits recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AskCompany />
    </div>
  );
}
