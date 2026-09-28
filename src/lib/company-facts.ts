import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only, tenant-scoped facts about one client's business, used to answer
 * "Ask your company" questions. Every query is filtered by client_id, and the
 * result contains only counts/aggregates (no emails, tokens or message bodies).
 */
export interface CompanyFacts {
  as_of: string;
  leads: { total: number; today: number; last_7_days: number; last_30_days: number; contacted: number; replied: number; positive_replies: number; angry_replies: number; booked: number; unsubscribed: number };
  bookings: { total: number; upcoming: number };
  outreach: { emails_sent_total: number; emails_sent_last_7_days: number };
  campaigns: { total: number };
  ads: Record<string, number>;
  proposals: Record<string, number>;
  proposals_won_revenue: number;
  projects: Record<string, number>;
  infrastructure: { domains: number; mailboxes: number; social_connections: number };
  /**
   * What was actually published on social, with the title and the time — this
   * is what the voice agent reads back when the owner asks "what did you post
   * today?" or "when did that go out?".
   */
  social: {
    posts_total: number;
    posts_published: number;
    posts_draft: number;
    recent: { platform: string; title: string; status: string; published_at: string | null }[];
  };
  /**
   * Ad money. `actual_spend`/`roi` are null on purpose when the platform-level
   * performance data has not been synced (ad_performance is empty today) — the
   * agent must say it does not have the figure rather than report a guess.
   * `daily_budget_total` is the PLANNED budget from the campaigns we launched.
   */
  ad_spend: {
    campaigns_by_status: Record<string, number>;
    campaigns_by_platform: Record<string, number>;
    daily_budget_total: number;
    planned_monthly_spend: number;
    /** Sum of ad_performance.spend for this client's campaigns. null when nothing has been synced. */
    actual_spend: number | null;
    /** Company revenue divided by ad spend. NOT ad-attributed — see roi_basis. */
    roi: number | null;
    /** Ad-attributed leads, summed from ad_performance. null when nothing has been synced. */
    ad_leads: number | null;
    cost_per_lead: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    last_synced_at: string | null;
    roi_basis: string;
    note: string;
  };
  deals: { closed: number; won_revenue: number };
  /**
   * "What happened today" in the CLIENT's own timezone — the daily brief.
   * Emails are counted from outreach_log.sent_at and broken down per mailbox;
   * posts carry their publish/schedule time.
   */
  brief: {
    timezone: string;
    day_start: string;
    emails_sent_today: number;
    mailboxes: { address: string; sent_today: number; sent_total: number; daily_limit: number | null }[];
    posts_today: { platform: string; title: string; status: string; at: string | null }[];
    posts_published_today: number;
    posts_scheduled_next: { platform: string; title: string; at: string | null }[];
    domains: { domain: string; dns_status: string | null; bought_at: string }[];
    domains_bought_today: number;
  };
}

/** UTC instant of 00:00 today in `tz` (falls back to UTC midnight for an unknown zone). */
export function startOfLocalDay(tz: string, now = new Date()): Date {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    const l = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const midnightLocal = Math.floor(l / 864e5) * 864e5;
    return new Date(now.getTime() - (l - midnightLocal));
  } catch {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Filter = (q: any) => any;

export async function getCompanyFacts(admin: SupabaseClient, clientId: string, timezone = "UTC"): Promise<CompanyFacts> {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const startOfDay = startOfLocalDay(timezone, now);
  const DAY = 864e5;

  const count = async (table: string, f: Filter): Promise<number> => {
    const { count: c } = await f(admin.from(table).select("id", { count: "exact", head: true }).eq("client_id", clientId));
    return c ?? 0;
  };
  const group = async (table: string, col: string): Promise<Record<string, number>> => {
    const { data } = await admin.from(table).select(col).eq("client_id", clientId).limit(5000);
    const out: Record<string, number> = {};
    for (const r of (data ?? []) as unknown as Record<string, string | null>[]) {
      const k = r[col] ?? "unknown";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  const [total, today, d7, d30, contacted, replied, positive, angry, booked, unsub, bTotal, bUpcoming, sentTotal, sent7, camps, domains, mailboxes, socials] = await Promise.all([
    count("leads", (q) => q),
    count("leads", (q) => q.gte("created_at", startOfDay.toISOString())),
    count("leads", (q) => q.gte("created_at", ago(7 * DAY))),
    count("leads", (q) => q.gte("created_at", ago(30 * DAY))),
    count("leads", (q) => q.not("last_contact_at", "is", null)),
    count("leads", (q) => q.eq("reply_received", true)),
    count("leads", (q) => q.in("reply_classification", ["HAPPY", "BOOKING"])),
    count("leads", (q) => q.eq("reply_classification", "ANGRY")),
    count("leads", (q) => q.eq("booked", true)),
    count("leads", (q) => q.eq("unsubscribed", true)),
    count("bookings", (q) => q),
    count("bookings", (q) => q.gte("scheduled_at", now.toISOString())),
    count("outreach_log", (q) => q.gt("touch_number", 0)),
    count("outreach_log", (q) => q.gt("touch_number", 0).gte("sent_at", ago(7 * DAY))),
    count("campaigns", (q) => q),
    count("domains", (q) => q),
    count("mailboxes", (q) => q),
    count("social_connections", (q) => q),
  ]);

  const [ads, proposals, projects, adPlatforms] = await Promise.all([
    group("ad_campaigns", "status"),
    group("proposals", "status"),
    group("projects", "status"),
    group("ad_campaigns", "platform"),
  ]);
  const { data: won } = await admin.from("proposals").select("amount").eq("client_id", clientId).eq("status", "won").limit(5000);

  // Social: what was posted, with a human-readable title and the time.
  const { data: postRows } = await admin
    .from("social_posts")
    .select("platform, topic, caption, status, published_at")
    .eq("client_id", clientId)
    .order("published_at", { ascending: false, nullsFirst: true })
    .limit(10);
  const [postsTotal, postsPublished, postsDraft] = await Promise.all([
    count("social_posts", (q) => q),
    count("social_posts", (q) => q.eq("status", "published")),
    count("social_posts", (q) => q.eq("status", "draft")),
  ]);

  // Ad money we can actually stand behind: the PLANNED daily budget of the
  // campaigns we launched, plus whatever the performance sync has recorded.
  //
  // ad_performance carries no client_id — it hangs off a campaign — so the
  // client's campaigns have to be collected first and used as the filter. It is
  // empty today because no campaign has ever been confirmed by the provider
  // (the sync marks them "Provider does not confirm this campaign"), and that
  // is exactly why actual_spend/roi stay null: reporting a number here when the
  // table is empty would be inventing one.
  const { data: budgetRows } = await admin
    .from("ad_campaigns")
    .select("id, daily_budget")
    .eq("client_id", clientId)
    .limit(2000);
  const dailyBudgetTotal = (budgetRows ?? []).reduce(
    (s: number, r: { daily_budget: number | null }) => s + (Number(r.daily_budget) || 0),
    0
  );

  const campaignIds = (budgetRows ?? []).map((r: { id: string }) => r.id);
  let perfRows: { spend: number | null; impressions: number | null; clicks: number | null; ctr: number | null; leads: number | null; synced_at: string | null }[] = [];
  if (campaignIds.length) {
    const { data } = await admin
      .from("ad_performance")
      .select("spend, impressions, clicks, ctr, leads, synced_at")
      .in("ad_campaign_id", campaignIds)
      .limit(5000);
    perfRows = (data ?? []) as typeof perfRows;
  }
  const hasPerf = perfRows.length > 0;
  const actualSpend = perfRows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
  const adLeads = perfRows.reduce((s, r) => s + (Number(r.leads) || 0), 0);
  const perfImpressions = perfRows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  const perfClicks = perfRows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const lastSynced = perfRows.map((r) => r.synced_at).filter(Boolean).sort().pop() ?? null;

  // --- daily brief -----------------------------------------------------------
  const dayStartIso = startOfDay.toISOString();
  const { data: mbRows } = await admin.from("mailboxes").select("id, address, daily_send_limit").eq("client_id", clientId).limit(200);
  const { data: sentToday } = await admin
    .from("outreach_log")
    .select("mailbox_id")
    .eq("client_id", clientId)
    .gt("touch_number", 0)
    .gte("sent_at", dayStartIso)
    .limit(10000);
  const todayByMailbox = new Map<string, number>();
  for (const r of (sentToday ?? []) as { mailbox_id: string | null }[]) {
    if (r.mailbox_id) todayByMailbox.set(r.mailbox_id, (todayByMailbox.get(r.mailbox_id) ?? 0) + 1);
  }
  const mailboxBrief = await Promise.all(
    ((mbRows ?? []) as { id: string; address: string; daily_send_limit: number | null }[]).map(async (m) => ({
      address: m.address,
      sent_today: todayByMailbox.get(m.id) ?? 0,
      sent_total: await count("outreach_log", (q) => q.eq("mailbox_id", m.id).gt("touch_number", 0)),
      daily_limit: m.daily_send_limit ?? null,
    }))
  );
  type PostRow = { platform: string | null; topic: string | null; caption: string | null; status: string | null; published_at: string | null; scheduled_for: string | null };
  const { data: postsToday } = await admin
    .from("social_posts")
    .select("platform, topic, caption, status, published_at, scheduled_for")
    .eq("client_id", clientId)
    .or(`published_at.gte.${dayStartIso},scheduled_for.gte.${dayStartIso}`)
    .order("published_at", { ascending: true, nullsFirst: false })
    .limit(50);
  const postTitle = (p: PostRow) => p.topic?.trim() || (p.caption ?? "").slice(0, 70) || "(no caption)";
  const postList = (postsToday ?? []) as PostRow[];
  const publishedToday = postList.filter((p) => p.status === "published" && p.published_at && p.published_at >= dayStartIso);
  const upcoming = postList.filter((p) => p.status !== "published" && p.scheduled_for && p.scheduled_for >= now.toISOString());
  const { data: domainRows } = await admin.from("domains").select("domain, dns_status, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(50);
  const domainList = (domainRows ?? []) as { domain: string; dns_status: string | null; created_at: string }[];

  const wonRevenue = (won ?? []).reduce((s: number, r: { amount: number | null }) => s + (Number(r.amount) || 0), 0);

  return {
    as_of: now.toISOString(),
    leads: { total, today, last_7_days: d7, last_30_days: d30, contacted, replied, positive_replies: positive, angry_replies: angry, booked, unsubscribed: unsub },
    bookings: { total: bTotal, upcoming: bUpcoming },
    outreach: { emails_sent_total: sentTotal, emails_sent_last_7_days: sent7 },
    campaigns: { total: camps },
    ads,
    proposals,
    proposals_won_revenue: wonRevenue,
    projects,
    infrastructure: { domains, mailboxes, social_connections: socials },
    social: {
      posts_total: postsTotal,
      posts_published: postsPublished,
      posts_draft: postsDraft,
      recent: (postRows ?? []).map((p: { platform: string | null; topic: string | null; caption: string | null; status: string | null; published_at: string | null }) => ({
        platform: p.platform ?? "unknown",
        title: p.topic?.trim() || (p.caption ?? "").slice(0, 70) || "(no caption)",
        status: p.status ?? "unknown",
        published_at: p.published_at,
      })),
    },
    ad_spend: {
      campaigns_by_status: ads,
      campaigns_by_platform: adPlatforms,
      daily_budget_total: dailyBudgetTotal,
      planned_monthly_spend: Math.round(dailyBudgetTotal * 30 * 100) / 100,
      actual_spend: hasPerf ? Math.round(actualSpend * 100) / 100 : null,
      // Revenue over spend. It is the whole company's won revenue, not revenue
      // provably caused by the ads, so the basis says so and the agent must too.
      roi: hasPerf && actualSpend > 0 ? Math.round((wonRevenue / actualSpend) * 100) / 100 : null,
      ad_leads: hasPerf ? adLeads : null,
      cost_per_lead: hasPerf && adLeads > 0 ? Math.round((actualSpend / adLeads) * 100) / 100 : null,
      impressions: hasPerf ? perfImpressions : null,
      clicks: hasPerf ? perfClicks : null,
      ctr: hasPerf && perfImpressions > 0 ? Math.round((perfClicks / perfImpressions) * 10000) / 100 : null,
      last_synced_at: lastSynced,
      roi_basis: "company-wide won revenue divided by total ad spend — NOT revenue attributed to the ads",
      note: hasPerf
        ? "actual_spend comes from the ad performance sync; ROI is company-wide, not ad-attributed."
        : "No ad performance has ever been recorded — the provider does not confirm any of this client's campaigns, so actual spend and ROI are genuinely unknown. Only the planned daily budget is known.",
    },
    deals: {
      closed: proposals.won ?? 0,
      won_revenue: wonRevenue,
    },
    brief: {
      timezone,
      day_start: dayStartIso,
      emails_sent_today: sentToday?.length ?? 0,
      mailboxes: mailboxBrief,
      posts_today: publishedToday.map((p) => ({ platform: p.platform ?? "unknown", title: postTitle(p), status: "published", at: p.published_at })),
      posts_published_today: publishedToday.length,
      posts_scheduled_next: upcoming.slice(0, 5).map((p) => ({ platform: p.platform ?? "unknown", title: postTitle(p), at: p.scheduled_for })),
      domains: domainList.map((d) => ({ domain: d.domain, dns_status: d.dns_status, bought_at: d.created_at })),
      domains_bought_today: domainList.filter((d) => d.created_at >= dayStartIso).length,
    },
  };
}
