// Demo/local data for the executive workspace prototype views.
// This is UI-prototype data only — no backend calls, per the design pass scope.

export type LeadStage = "New" | "Contacted" | "Qualified" | "Proposal";

export interface Lead {
  id: string;
  name: string;
  company: string;
  role: string;
  match: number;
  stage: LeadStage;
  source: string;
  lastTouch: string;
  avatarColor: string;
}

export const LEADS: Lead[] = [
  { id: "l1", name: "Maya Chen", company: "Arcwell Studio", role: "Founder", match: 94, stage: "Qualified", source: "Referral", lastTouch: "2 hours ago", avatarColor: "#7357FF" },
  { id: "l2", name: "Owen Patel", company: "Signalform", role: "VP Marketing", match: 89, stage: "Proposal", source: "Outbound", lastTouch: "Yesterday", avatarColor: "#3485D8" },
  { id: "l3", name: "Nora Williams", company: "Goodkind Health", role: "Co-founder", match: 86, stage: "Contacted", source: "Inbound", lastTouch: "3 days ago", avatarColor: "#16A36B" },
  { id: "l4", name: "Ethan Brooks", company: "Civic North", role: "Managing Partner", match: 81, stage: "New", source: "Event", lastTouch: "5 days ago", avatarColor: "#F08C46" },
  { id: "l5", name: "Sofia Alvarez", company: "Modo Finance", role: "Head of Growth", match: 78, stage: "Contacted", source: "Outbound", lastTouch: "1 week ago", avatarColor: "#7357FF" },
  { id: "l6", name: "Liam Fraser", company: "Morrow Labs", role: "Founder", match: 74, stage: "New", source: "Referral", lastTouch: "1 week ago", avatarColor: "#3485D8" },
];

export const LEAD_STAGES: LeadStage[] = ["New", "Contacted", "Qualified", "Proposal"];

export type ContentStatus = "Scheduled" | "In review" | "Published" | "Draft";

export interface ContentItem {
  id: string;
  title: string;
  channel: string;
  status: ContentStatus;
  publishDate: string;
  reach: string;
}

export const CONTENT_ITEMS: ContentItem[] = [
  { id: "c1", title: "The lean growth stack for 2026", channel: "LinkedIn", status: "Scheduled", publishDate: "Oct 06", reach: "—" },
  { id: "c2", title: "How to turn one case study into six assets", channel: "Newsletter", status: "In review", publishDate: "Oct 09", reach: "—" },
  { id: "c3", title: "Founder-led sales: the first 30 days", channel: "LinkedIn", status: "Published", publishDate: "Sep 28", reach: "12.1k" },
  { id: "c4", title: "Behind the scenes: campaign sprint", channel: "Instagram", status: "Draft", publishDate: "—", reach: "—" },
];

export type ProjectHealth = "On track" | "At risk";

export interface Project {
  id: string;
  name: string;
  client: string;
  health: ProjectHealth;
  progress: number;
  due: string;
  tasksDone: number;
  tasksTotal: number;
  owner: string;
  upcomingTasks: { id: string; label: string; done: boolean }[];
}

export const PROJECTS: Project[] = [
  {
    id: "p1",
    name: "Arcwell launch campaign",
    client: "Arcwell Studio",
    health: "On track",
    progress: 78,
    due: "Oct 08",
    tasksDone: 18,
    tasksTotal: 23,
    owner: "Alex Hart",
    upcomingTasks: [
      { id: "t1", label: "Finalize launch creative set", done: true },
      { id: "t2", label: "Approve media budget", done: false },
      { id: "t3", label: "Schedule launch-day posts", done: false },
    ],
  },
  {
    id: "p2",
    name: "Q4 content engine",
    client: "Internal",
    health: "At risk",
    progress: 44,
    due: "Oct 14",
    tasksDone: 9,
    tasksTotal: 21,
    owner: "Priya Nair",
    upcomingTasks: [
      { id: "t4", label: "Resolve editorial calendar gaps", done: false },
      { id: "t5", label: "Record two founder clips", done: false },
      { id: "t6", label: "Confirm newsletter sponsor slot", done: true },
    ],
  },
  {
    id: "p3",
    name: "Signalform brand refresh",
    client: "Signalform",
    health: "On track",
    progress: 62,
    due: "Oct 22",
    tasksDone: 11,
    tasksTotal: 18,
    owner: "Jordan Lee",
    upcomingTasks: [
      { id: "t7", label: "Client review of brand guide", done: false },
      { id: "t8", label: "Deliver updated web assets", done: false },
      { id: "t9", label: "Handoff to social team", done: false },
    ],
  },
];

export interface Invoice {
  id: string;
  client: string;
  amount: number;
  due: string;
  urgent: boolean;
}

export const OUTSTANDING_INVOICES: Invoice[] = [
  { id: "i1", client: "Goodkind Health", amount: 4800, due: "Due today", urgent: true },
  { id: "i2", client: "Signalform", amount: 3200, due: "Due Oct 08", urgent: false },
  { id: "i3", client: "Civic North", amount: 2460, due: "Due Oct 14", urgent: false },
  { id: "i4", client: "Modo Finance", amount: 2400, due: "Due Oct 22", urgent: false },
];

export const CASH_FLOW_MONTHS = [
  { month: "May", income: 18200, expenses: 9100 },
  { month: "Jun", income: 20650, expenses: 9800 },
  { month: "Jul", income: 19400, expenses: 10200 },
  { month: "Aug", income: 23100, expenses: 8700 },
  { month: "Sep", income: 25900, expenses: 9400 },
  { month: "Oct", income: 24680, expenses: 8420 },
];

export const REVENUE_MONTHS = [
  { month: "May", value: 16200 },
  { month: "Jun", value: 18650 },
  { month: "Jul", value: 17400 },
  { month: "Aug", value: 20100 },
  { month: "Sep", value: 22900 },
  { month: "Oct", value: 24680 },
];

export type ActivityCategory = "Revenue" | "Projects" | "Leads";

export interface ActivityEvent {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  category: ActivityCategory;
  tone: "success" | "info" | "warning" | "neutral";
}

export const ACTIVITY_EVENTS: ActivityEvent[] = [
  { id: "a1", title: "Proposal approved", detail: "Signalform · brand refresh scope", timestamp: "10 min ago", category: "Revenue", tone: "success" },
  { id: "a2", title: "Outreach sequence completed", detail: "Civic North · 4-step founder sequence", timestamp: "42 min ago", category: "Leads", tone: "info" },
  { id: "a3", title: "Task moved to review", detail: "Q4 content engine · newsletter draft", timestamp: "1 hour ago", category: "Projects", tone: "neutral" },
  { id: "a4", title: "Invoice paid", detail: "Modo Finance · $2,400 settled", timestamp: "3 hours ago", category: "Revenue", tone: "success" },
  { id: "a5", title: "Lead marked qualified", detail: "Maya Chen · Arcwell Studio", timestamp: "Yesterday", category: "Leads", tone: "info" },
  { id: "a6", title: "Budget flagged for review", detail: "Q4 content engine · over allocation risk", timestamp: "Yesterday", category: "Projects", tone: "warning" },
];

export const PRIORITY_QUEUE = [
  { id: "q1", kind: "review" as const, title: "Approve the Q4 media budget", meta: "Arcwell launch campaign · due today", cta: "Review" },
  { id: "q2", kind: "ai" as const, title: "3 leads are ready for a personal follow-up", meta: "High intent · updated 12 min ago", cta: "Open leads" },
  { id: "q3", kind: "review" as const, title: "Content review is waiting on you", meta: "2 assets · scheduled for tomorrow", cta: "Review" },
];

export const UPCOMING_WORK = [
  { id: "u1", title: "Budget approval", detail: "Arcwell launch", date: "Oct 03" },
  { id: "u2", title: "Client check-in", detail: "Signalform refresh", date: "Oct 04" },
  { id: "u3", title: "Campaign launch", detail: "Q4 content engine", date: "Oct 07" },
  { id: "u4", title: "Invoice due", detail: "Goodkind Health", date: "Oct 08" },
];

export const BRIEFING_ITEMS = [
  { id: "b1", title: "Follow up with Arcwell", meta: "94% fit · proposal is warm" },
  { id: "b2", title: "Approve media budget", meta: "Campaign launches in 5 days" },
  { id: "b3", title: "Protect your focus time", meta: "2 meetings can be moved async" },
];

export const PROMPT_CHIPS = ["Best leads today", "What is at risk?", "Summarize finances"];

export function assistantReplyFor(prompt: string): string {
  const q = prompt.toLowerCase();
  if (q.includes("lead")) {
    return "Maya Chen (Arcwell Studio, 94% match) and Owen Patel (Signalform, 89% match) are your strongest opportunities right now. Both have gone quiet for over a week — a short personal note today would likely move them forward.";
  }
  if (q.includes("risk") || q.includes("project")) {
    return "The Q4 content engine is at risk: only 44% complete with 7 days to its next milestone. Consider reassigning one editorial task or moving the launch date by a few days.";
  }
  if (q.includes("financ") || q.includes("cash") || q.includes("revenue")) {
    return "Cash collected this month is $31,240 against $8,420 in operating expenses — a 48.6% net margin. $12,860 remains outstanding, with Goodkind Health's $4,800 invoice due today.";
  }
  return "Here is a quick read: pipeline is healthy at $86,400 qualified, two high-value leads have gone quiet, and one project needs attention this week. Ask about leads, risk, or finances for specifics.";
}
