/**
 * Server-only. Real data loaders for the "/workspace/*" executive UI. These
 * pages used to render entirely from src/lib/workspace-demo-data.ts (static,
 * fabricated arrays — fake names, fake dollar amounts, fake "match %"
 * scores). Every function here reads the same tables the rest of the app
 * already treats as the source of truth (leads, proposals, ledger_entries,
 * projects, bookings, budget_requests, social_posts) and is scoped by RLS
 * through the caller's own Supabase session client — nothing here accepts
 * or needs a client_id parameter.
 *
 * Presentational fields that have no real backing (lead "match %", a
 * project's "health"/"progress %", invoice "urgent" flags, social post
 * "reach") are not fabricated here — see each page for what was dropped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { stageForLead, type PipelineStageId, type PipelineLeadInput } from "@/lib/pipeline-stage";
import { formatLocalDateTime } from "@/lib/format-date";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** UTC month boundaries, `offsetMonths` months from the current month (negative = past). */
function monthRange(offsetMonths: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 1));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function monthLabel(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

/** Deterministic avatar color from a name — presentational only, not a data claim. */
const AVATAR_PALETTE = ["#7357FF", "#3485D8", "#16A36B", "#F08C46"];
export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

/** "2 hours ago" / "Yesterday" / "Oct 03" style relative label for a real timestamp. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "Yesterday" : `${days} days ago`;
  return formatLocalDateTime(iso).split(",")[0];
}

export function fmtMoney(n: number | null | undefined): string {
  return n == null ? "$0" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ---------------------------------------------------------------------------
// Leads & pipeline — same source as /pipeline (proposals + outreach stage)
// ---------------------------------------------------------------------------

export type WorkspaceStage = PipelineStageId; // "sent" | "negotiation" | "won" | "lost"

export const STAGE_LABEL: Record<WorkspaceStage, string> = {
  sent: "Contacted",
  negotiation: "In conversation",
  won: "Won",
  lost: "Lost",
};

export interface WorkspaceLead {
  id: string;
  name: string;
  company: string;
  role: string | null;
  stage: WorkspaceStage;
  stageDetail: string;
  source: string;
  lastTouchISO: string | null;
  amount: number | null;
}

interface ProposalRow {
  id: string;
  lead_id: string | null;
  amount: number | null;
  status: string;
  sent_at: string;
  leads: { name: string | null; company: string | null; job_title: string | null; lead_source: string | null } | null;
}

interface ContactedLeadRow extends PipelineLeadInput {
  id: string;
  name: string | null;
  company: string | null;
  job_title: string | null;
  lead_source: string | null;
}

const VALID_STAGES = new Set<string>(["sent", "negotiation", "won", "lost"]);

export async function getWorkspaceLeads(supabase: Supabase): Promise<WorkspaceLead[]> {
  const [{ data: proposals }, { data: contacted }] = await Promise.all([
    supabase
      .from("proposals")
      .select("id, lead_id, amount, status, sent_at, leads(name, company, job_title, lead_source)")
      .order("sent_at", { ascending: false })
      .returns<ProposalRow[]>(),
    supabase
      .from("leads")
      .select(
        "id, name, company, job_title, lead_source, status, follow_up_number, last_contact_at, reply_received, reply_classification, booked, unsubscribed, email_bounced, complained, manually_stopped"
      )
      .or("last_contact_at.not.is.null,follow_up_number.gte.1,reply_received.eq.true")
      .order("last_contact_at", { ascending: false, nullsFirst: false })
      .limit(300)
      .returns<ContactedLeadRow[]>(),
  ]);

  const proposalLeadIds = new Set((proposals ?? []).map((p) => p.lead_id).filter(Boolean));

  const fromProposals: WorkspaceLead[] = (proposals ?? [])
    .filter((p) => VALID_STAGES.has(p.status))
    .map((p) => ({
      id: p.id,
      name: p.leads?.name || p.leads?.company || "Untitled deal",
      company: p.leads?.company || "—",
      role: p.leads?.job_title ?? null,
      stage: p.status as WorkspaceStage,
      stageDetail: "Proposal sent",
      source: p.leads?.lead_source || "—",
      lastTouchISO: p.sent_at,
      amount: p.amount,
    }));

  const fromOutreach: WorkspaceLead[] = (contacted ?? [])
    .filter((l) => !proposalLeadIds.has(l.id))
    .flatMap((l) => {
      const s = stageForLead(l);
      if (!s) return [];
      return [
        {
          id: l.id,
          name: l.name || l.company || "Untitled",
          company: l.company || "—",
          role: l.job_title ?? null,
          stage: s.stage,
          stageDetail: s.detail,
          source: l.lead_source || "—",
          lastTouchISO: l.last_contact_at ?? null,
          amount: null,
        },
      ];
    });

  return [...fromProposals, ...fromOutreach];
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface WorkspaceOpenProposal {
  id: string;
  client: string;
  amount: number;
  sentAtISO: string;
}

export interface WorkspaceCashFlowMonth {
  month: string;
  income: number;
  expenses: number;
}

export interface WorkspaceFinance {
  cashCollected: number;
  openProposalsValue: number;
  openProposalsCount: number;
  operatingExpenses: number;
  netMarginPct: number | null;
  openProposals: WorkspaceOpenProposal[];
  cashFlowMonths: WorkspaceCashFlowMonth[];
}

export async function getWorkspaceFinance(supabase: Supabase): Promise<WorkspaceFinance> {
  const { startISO: thisMonthStart } = monthRange(0);
  const { startISO: sixMoStart } = monthRange(-5);

  const [{ data: ledger6mo }, { data: openProposalsRaw }] = await Promise.all([
    supabase
      .from("ledger_entries")
      .select("entry_type, amount, occurred_at")
      .gte("occurred_at", sixMoStart)
      .returns<{ entry_type: "revenue" | "expense"; amount: number; occurred_at: string }[]>(),
    supabase
      .from("proposals")
      .select("id, amount, sent_at, leads(company, name)")
      .eq("status", "sent")
      .not("amount", "is", null)
      .order("sent_at", { ascending: false })
      .returns<{ id: string; amount: number | null; sent_at: string; leads: { company: string | null; name: string | null } | null }[]>(),
  ]);

  const entries = ledger6mo ?? [];
  const thisMonth = entries.filter((e) => e.occurred_at >= thisMonthStart);
  const cashCollected = thisMonth.filter((e) => e.entry_type === "revenue").reduce((s, e) => s + Number(e.amount), 0);
  const operatingExpenses = thisMonth.filter((e) => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount), 0);

  const cashFlowMonths: WorkspaceCashFlowMonth[] = [];
  for (let i = 5; i >= 0; i--) {
    const { startISO, endISO } = monthRange(-i);
    const bucket = entries.filter((e) => e.occurred_at >= startISO && e.occurred_at < endISO);
    cashFlowMonths.push({
      month: monthLabel(startISO),
      income: bucket.filter((e) => e.entry_type === "revenue").reduce((s, e) => s + Number(e.amount), 0),
      expenses: bucket.filter((e) => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount), 0),
    });
  }

  const openProposals = (openProposalsRaw ?? []).map((p) => ({
    id: p.id,
    client: p.leads?.company || p.leads?.name || "Untitled deal",
    amount: Number(p.amount ?? 0),
    sentAtISO: p.sent_at,
  }));
  const openProposalsValue = openProposals.reduce((s, p) => s + p.amount, 0);

  return {
    cashCollected,
    openProposalsValue,
    openProposalsCount: openProposals.length,
    operatingExpenses,
    netMarginPct: cashCollected > 0 ? ((cashCollected - operatingExpenses) / cashCollected) * 100 : null,
    openProposals,
    cashFlowMonths,
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type WorkspaceProjectStatus =
  | "not_started" | "started" | "in_development" | "qa" | "client_review" | "delivered" | "closed" | "blocked";

const ACTIVE_PROJECT_STATUSES = new Set<WorkspaceProjectStatus>(["not_started", "started", "in_development", "qa", "client_review"]);

export interface WorkspaceProject {
  id: string;
  name: string;
  status: WorkspaceProjectStatus;
  isBlocked: boolean;
  blockReason: string | null;
  deadlineISO: string | null;
  revenue: number | null;
  cost: number | null;
  updatedAtISO: string;
}

export interface WorkspaceProjectsData {
  projects: WorkspaceProject[];
  activeCount: number;
  blockedCount: number;
  totalRevenue: number;
}

export async function getWorkspaceProjects(supabase: Supabase): Promise<WorkspaceProjectsData> {
  const { data } = await supabase
    .from("projects")
    .select("id, name, status, is_blocked, block_reason, deadline, revenue, cost, updated_at")
    .order("updated_at", { ascending: false })
    .returns<
      {
        id: string;
        name: string;
        status: WorkspaceProjectStatus;
        is_blocked: boolean | null;
        block_reason: string | null;
        deadline: string | null;
        revenue: number | null;
        cost: number | null;
        updated_at: string;
      }[]
    >();

  const projects: WorkspaceProject[] = (data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    isBlocked: Boolean(p.is_blocked),
    blockReason: p.block_reason,
    deadlineISO: p.deadline,
    revenue: p.revenue,
    cost: p.cost,
    updatedAtISO: p.updated_at,
  }));

  return {
    projects,
    activeCount: projects.filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status)).length,
    blockedCount: projects.filter((p) => p.isBlocked).length,
    totalRevenue: projects.reduce((s, p) => s + Number(p.revenue ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Activity — merged real events from every table that has a real timestamp
// ---------------------------------------------------------------------------

export type WorkspaceActivityCategory = "Revenue" | "Projects" | "Leads" | "Content";
export type WorkspaceActivityTone = "success" | "info" | "warning" | "neutral";

export interface WorkspaceActivityEvent {
  id: string;
  title: string;
  detail: string;
  timestampISO: string;
  category: WorkspaceActivityCategory;
  tone: WorkspaceActivityTone;
}

export async function getWorkspaceActivity(supabase: Supabase, limit = 20): Promise<WorkspaceActivityEvent[]> {
  const [{ data: ledger }, { data: bookings }, { data: leadsRecent }, { data: posts }, { data: recentProjects }] = await Promise.all([
    supabase
      .from("ledger_entries")
      .select("id, entry_type, amount, category, description, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(10)
      .returns<{ id: string; entry_type: "revenue" | "expense"; amount: number; category: string | null; description: string | null; occurred_at: string }[]>(),
    supabase
      .from("bookings")
      .select("id, invitee_email, booking_status, created_at")
      .order("created_at", { ascending: false })
      .limit(10)
      .returns<{ id: string; invitee_email: string | null; booking_status: string; created_at: string }[]>(),
    supabase
      .from("leads")
      .select("id, name, company, booked, reply_received, reply_classification, last_contact_at")
      .not("last_contact_at", "is", null)
      .order("last_contact_at", { ascending: false })
      .limit(10)
      .returns<{ id: string; name: string | null; company: string | null; booked: boolean | null; reply_received: boolean | null; reply_classification: string | null; last_contact_at: string | null }[]>(),
    supabase
      .from("social_posts")
      .select("id, platform, topic, caption, published_at")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(10)
      .returns<{ id: string; platform: string; topic: string | null; caption: string | null; published_at: string | null }[]>(),
    supabase
      .from("projects")
      .select("id, name, status, updated_at")
      .order("updated_at", { ascending: false })
      .limit(10)
      .returns<{ id: string; name: string; status: string; updated_at: string }[]>(),
  ]);

  const events: WorkspaceActivityEvent[] = [];

  for (const e of ledger ?? []) {
    events.push({
      id: `ledger-${e.id}`,
      title: e.entry_type === "revenue" ? "Revenue recorded" : "Expense recorded",
      detail: [e.category, e.description].filter(Boolean).join(" · ") || fmtMoney(e.amount),
      timestampISO: e.occurred_at,
      category: "Revenue",
      tone: e.entry_type === "revenue" ? "success" : "warning",
    });
  }
  for (const b of bookings ?? []) {
    events.push({
      id: `booking-${b.id}`,
      title: b.booking_status === "canceled" ? "Booking canceled" : "Meeting booked",
      detail: b.invitee_email || "—",
      timestampISO: b.created_at,
      category: "Leads",
      tone: b.booking_status === "canceled" ? "warning" : "success",
    });
  }
  for (const l of leadsRecent ?? []) {
    if (!l.last_contact_at) continue;
    if (l.booked) {
      events.push({
        id: `lead-booked-${l.id}`,
        title: "Lead booked a meeting",
        detail: l.company || l.name || "Lead",
        timestampISO: l.last_contact_at,
        category: "Leads",
        tone: "success",
      });
    } else if (l.reply_received) {
      events.push({
        id: `lead-reply-${l.id}`,
        title: "Lead replied",
        detail: [l.company || l.name || "Lead", l.reply_classification?.toLowerCase()].filter(Boolean).join(" · "),
        timestampISO: l.last_contact_at,
        category: "Leads",
        tone: "info",
      });
    }
  }
  for (const p of posts ?? []) {
    if (!p.published_at) continue;
    events.push({
      id: `post-${p.id}`,
      title: "Content published",
      detail: [p.platform, p.topic || p.caption?.slice(0, 40)].filter(Boolean).join(" · "),
      timestampISO: p.published_at,
      category: "Content",
      tone: "info",
    });
  }
  for (const p of recentProjects ?? []) {
    events.push({
      id: `project-${p.id}`,
      title: "Project updated",
      detail: `${p.name} · ${p.status.replace(/_/g, " ")}`,
      timestampISO: p.updated_at,
      category: "Projects",
      tone: "neutral",
    });
  }

  events.sort((a, b) => new Date(b.timestampISO).getTime() - new Date(a.timestampISO).getTime());
  return events.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Campaigns & content
// ---------------------------------------------------------------------------

export type WorkspaceContentStatus = "creating" | "draft" | "scheduled" | "published" | "failed";

export interface WorkspaceContentItem {
  id: string;
  title: string;
  channel: string;
  status: WorkspaceContentStatus;
  publishDateISO: string | null;
}

export interface WorkspaceContentData {
  items: WorkspaceContentItem[];
  publishedThisMonth: number;
  draftsAwaiting: number;
  failedThisMonth: number;
}

export async function getWorkspaceContent(supabase: Supabase): Promise<WorkspaceContentData> {
  const { data } = await supabase
    .from("social_posts")
    .select("id, platform, topic, caption, status, published_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<{ id: string; platform: string; topic: string | null; caption: string | null; status: WorkspaceContentStatus | null; published_at: string | null; created_at: string }[]>();

  const items: WorkspaceContentItem[] = (data ?? []).map((p) => ({
    id: p.id,
    title: p.topic || (p.caption ? p.caption.slice(0, 60) : "Untitled post"),
    channel: p.platform,
    status: p.status ?? "draft",
    publishDateISO: p.published_at,
  }));

  const { startISO: monthStart } = monthRange(0);
  return {
    items,
    publishedThisMonth: items.filter((i) => i.status === "published" && i.publishDateISO && i.publishDateISO >= monthStart).length,
    draftsAwaiting: items.filter((i) => i.status === "draft").length,
    failedThisMonth: items.filter((i) => i.status === "failed").length,
  };
}

// ---------------------------------------------------------------------------
// Overview — the combined summary
// ---------------------------------------------------------------------------

export interface WorkspacePriorityItem {
  id: string;
  title: string;
  meta: string;
}

export interface WorkspaceUpcomingItem {
  id: string;
  title: string;
  detail: string;
  dateISO: string;
}

export interface WorkspaceOverview {
  revenueThisMonth: number;
  revenueTrendPct: number | null;
  openProposalsValue: number;
  activeProjectsCount: number;
  upcomingAppointments: number;
  revenueMonths: { month: string; value: number }[];
  priorityQueue: WorkspacePriorityItem[];
  recentActivity: WorkspaceActivityEvent[];
  upcomingWork: WorkspaceUpcomingItem[];
}

export async function getWorkspaceOverview(supabase: Supabase): Promise<WorkspaceOverview> {
  const { startISO: thisMonthStart } = monthRange(0);
  const { startISO: lastMonthStart, endISO: lastMonthEnd } = monthRange(-1);
  const { startISO: sixMoStart } = monthRange(-5);
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();

  const [
    { data: ledger6mo },
    { data: openProposalsRaw },
    { data: projects },
    { count: upcomingAppointments },
    { data: budgetRequestsPending },
    { data: overdueLeads },
    { data: upcomingBookings },
    recentActivity,
  ] = await Promise.all([
    supabase
      .from("ledger_entries")
      .select("entry_type, amount, occurred_at")
      .gte("occurred_at", sixMoStart)
      .returns<{ entry_type: "revenue" | "expense"; amount: number; occurred_at: string }[]>(),
    supabase.from("proposals").select("amount").eq("status", "sent").not("amount", "is", null).returns<{ amount: number | null }[]>(),
    supabase.from("projects").select("id, name, status, is_blocked, deadline").returns<{ id: string; name: string; status: WorkspaceProjectStatus; is_blocked: boolean | null; deadline: string | null }[]>(),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("booking_status", "scheduled").gte("scheduled_at", now.toISOString()),
    supabase.from("budget_requests").select("id, department, requested_amount").eq("status", "pending").returns<{ id: string; department: string; requested_amount: number }[]>(),
    supabase
      .from("leads")
      .select("id, name, company, next_follow_up_at")
      .lte("next_follow_up_at", now.toISOString())
      .not("next_follow_up_at", "is", null)
      .eq("reply_received", false)
      .eq("unsubscribed", false)
      .limit(5)
      .returns<{ id: string; name: string | null; company: string | null; next_follow_up_at: string | null }[]>(),
    supabase
      .from("bookings")
      .select("id, invitee_email, scheduled_at")
      .eq("booking_status", "scheduled")
      .gte("scheduled_at", now.toISOString())
      .lte("scheduled_at", in7Days)
      .returns<{ id: string; invitee_email: string | null; scheduled_at: string | null }[]>(),
    getWorkspaceActivity(supabase, 4),
  ]);

  const entries = ledger6mo ?? [];
  const revenueThisMonth = entries.filter((e) => e.entry_type === "revenue" && e.occurred_at >= thisMonthStart).reduce((s, e) => s + Number(e.amount), 0);
  const revenueLastMonth = entries
    .filter((e) => e.entry_type === "revenue" && e.occurred_at >= lastMonthStart && e.occurred_at < lastMonthEnd)
    .reduce((s, e) => s + Number(e.amount), 0);
  const revenueTrendPct = revenueLastMonth > 0 ? ((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100 : null;

  const revenueMonths = [];
  for (let i = 5; i >= 0; i--) {
    const { startISO, endISO } = monthRange(-i);
    const value = entries.filter((e) => e.entry_type === "revenue" && e.occurred_at >= startISO && e.occurred_at < endISO).reduce((s, e) => s + Number(e.amount), 0);
    revenueMonths.push({ month: monthLabel(startISO), value });
  }

  const openProposalsValue = (openProposalsRaw ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const activeProjectsCount = (projects ?? []).filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status)).length;

  const priorityQueue: WorkspacePriorityItem[] = [];
  for (const p of (projects ?? []).filter((p) => p.is_blocked)) {
    priorityQueue.push({ id: `blocked-${p.id}`, title: `${p.name} is blocked`, meta: "Project needs a decision" });
  }
  for (const b of budgetRequestsPending ?? []) {
    priorityQueue.push({ id: `budget-${b.id}`, title: `${b.department} budget request is pending`, meta: `${fmtMoney(Number(b.requested_amount))} requested` });
  }
  for (const l of overdueLeads ?? []) {
    priorityQueue.push({ id: `lead-${l.id}`, title: `Follow up with ${l.company || l.name || "a lead"}`, meta: "Follow-up is overdue" });
  }

  const upcomingWork: WorkspaceUpcomingItem[] = [];
  for (const p of (projects ?? []).filter((p) => p.deadline && p.deadline >= now.toISOString() && p.deadline <= in7Days)) {
    upcomingWork.push({ id: `proj-${p.id}`, title: "Project deadline", detail: p.name, dateISO: p.deadline! });
  }
  for (const b of upcomingBookings ?? []) {
    if (!b.scheduled_at) continue;
    upcomingWork.push({ id: `booking-${b.id}`, title: "Meeting scheduled", detail: b.invitee_email || "Booked appointment", dateISO: b.scheduled_at });
  }
  upcomingWork.sort((a, b) => new Date(a.dateISO).getTime() - new Date(b.dateISO).getTime());

  return {
    revenueThisMonth,
    revenueTrendPct,
    openProposalsValue,
    activeProjectsCount,
    upcomingAppointments: upcomingAppointments ?? 0,
    revenueMonths,
    priorityQueue: priorityQueue.slice(0, 6),
    recentActivity,
    upcomingWork: upcomingWork.slice(0, 6),
  };
}
