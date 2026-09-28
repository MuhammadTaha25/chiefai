export type LeadStatus =
  | "new" | "researching" | "qualified" | "email_sent" | "waiting_for_reply"
  | "follow_up_1" | "follow_up_2" | "follow_up_3" | "follow_up_4" | "follow_up_5"
  | "follow_up_6" | "follow_up_7" | "follow_up_8" | "follow_up_9" | "follow_up_10"
  | "responded" | "analyzing" | "positive" | "angry" | "booking"
  | "appointment_booked" | "proposal" | "negotiation" | "won" | "lost" | "dropped";

export type ProjectStatus =
  | "not_started" | "started" | "in_development" | "qa" | "client_review" | "delivered" | "closed" | "blocked";

export interface Client {
  id: string;
  auth_user_id: string | null;
  company_name: string | null;
  email: string | null;
  onboarding_status: "pending" | "active" | "suspended" | null;
  status: "active" | "inactive" | null;
  icp_industry: string | null;
  icp_min_employees: number | null;
  icp_max_employees: number | null;
  icp_location: string | null;
  sending_domain: string | null;
  zernio_profile_id: string | null;
  created_at: string;
}

export type LeadType = "inbound" | "outbound";

export interface Lead {
  // Real-state flags (already selected via "*"; used so the UI reflects
  // what actually happened, not just the AI-intent `status` label).
  booked?: boolean | null;
  unsubscribed?: boolean | null;
  email_bounced?: boolean | null;
  complained?: boolean | null;
  manually_stopped?: boolean | null;
  reply_classification?: string | null;
  id: string;
  client_id: string;
  lead_id: string | null;
  email: string | null;
  name: string | null;
  company: string | null;
  job_title: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  status: LeadStatus;
  lead_source: string | null;
  lead_type: LeadType;
  follow_up_number: number | null;
  next_follow_up_at: string | null;
  last_contact_at: string | null;
  reply_received: boolean | null;
  sentiment: string | null;
  lost_reason: string | null;
  created_at: string;
}

export interface SocialPost {
  id: string;
  client_id: string;
  platform: string;
  content_type: string | null;
  topic: string | null;
  caption: string | null;
  media_url: string | null;
  status: string | null;
  zernio_post_id: string | null;
  published_at: string | null;
}

export interface BudgetRequest {
  id: string;
  client_id: string;
  department: string;
  requested_amount: number;
  status: string;
  approved_amount: number | null;
  decision_reason: string | null;
  requested_at: string;
  decided_at: string | null;
}

export interface AdCampaign {
  id: string;
  client_id: string;
  platform: string;
  campaign_name: string | null;
  /** Human label of the ad set created under this campaign. */
  ad_set_name?: string | null;
  /** Human label of the ad itself. */
  ad_name?: string | null;
  daily_budget: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
  launched_at: string | null;
  /** Zernio/Meta objective actually bought (traffic, awareness, …). */
  objective?: string | null;
  /** Ad-set optimization goal (LANDING_PAGE_VIEWS, REACH, …). */
  optimization_goal?: string | null;
  /** Meta campaign / ad set / ad / creative ids — proof of the full hierarchy. */
  zernio_campaign_id?: string | null;
  ad_set_id?: string | null;
  ad_id?: string | null;
  creative_id?: string | null;
  /** The AI-generated image attached to the ad. */
  image_url?: string | null;
  targeting?: Record<string, unknown> | null;
  launch_payload?: {
    notes?: string[];
    warnings?: string[];
    hashtags?: string[];
    adjustments?: { what: string; original: string; adjusted: string; reason: string }[];
    resolution?: { kind: string; requested: string; resolvedName: string | null; metaId: string | null; status: string; note?: string }[];
    ai_validation?: { checks: { key: string; pass: boolean; note: string }[]; unsupported_claims: string[]; ai_unavailable?: boolean };
    aida?: { attention: string; interest: string; desire: string; action: string };
    strategy?: { audience_summary: string; creative_angle: string; focus_applied: string };
    creative_fallback?: string | null;
    meta_verification?: { key: string; ok: boolean; expected: string; actual: string }[];
    ads_manager_url?: string;
    meta_status?: string | null;
    pending_review?: boolean;
    budget?: { amount?: number; type?: string; level?: string; currency?: string | null };
    /** Meta's own placement previews (iframe src only, never raw HTML). */
    previews?: { format: string; src: string }[];
    /** Zernio's ad document id — what the preview endpoint takes. */
    zernio_ad_id?: string | null;
  } | null;
  reach_estimate?: { lower?: number | null; upper?: number | null } | null;
}

export interface AdFinanceDecision {
  id: string;
  ad_campaign_id: string;
  decision: "approved" | "rejected" | "pending_human";
  reason: string | null;
  based_on_prior_ad_id: string | null;
  decided_at: string;
}

export interface LedgerEntry {
  id: string;
  client_id: string;
  entry_type: "revenue" | "expense";
  category: string | null;
  amount: number;
  description: string | null;
  occurred_at: string;
}

export interface Project {
  id: string;
  client_id: string;
  name: string;
  status: ProjectStatus;
  is_blocked: boolean | null;
  block_reason: string | null;
  deadline: string | null;
  revenue: number | null;
  cost: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChiefOfStaffSummary {
  leads_today: number;
  leads_week: number;
  leads_month: number;
  contacted: number;
  replied: number;
  positive: number;
  angry: number;
  appointments_upcoming: number;
  revenue_this_month: number;
  ad_spend_this_week: number;
  cost_per_lead: number;
  active_projects: number;
}
