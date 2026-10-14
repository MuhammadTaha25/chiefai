import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/types/db";
import LeadsTable from "@/components/leads-table";
import AddLeadButton from "@/components/add-lead-button";

export default async function LeadsPage() {
  const supabase = await createClient();

  const [{ data: leadsRaw }, { data: bookingRows }, { data: campaignRows }] = await Promise.all([
    supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500)
      .returns<Lead[]>(),
    // Booking details per lead (RLS-scoped through the session client, so only
    // this client's own bookings are ever returned).
    supabase
      .from("bookings")
      .select("lead_id, scheduled_at, booking_status")
      .order("created_at", { ascending: false })
      .returns<{ lead_id: string; scheduled_at: string | null; booking_status: string }[]>(),
    // Campaign month + niche labels — join to leads via campaign_id
    supabase
      .from("campaigns")
      .select("id, campaign_month, niche")
      .returns<{ id: string; campaign_month: string | null; niche: string | null }[]>(),
  ]);

  const campaignById: Record<string, { campaign_month: string | null; niche: string | null }> = {};
  for (const c of campaignRows ?? []) campaignById[c.id] = { campaign_month: c.campaign_month, niche: c.niche };

  // Attach campaign_month + campaign_niche to each lead for display
  const leads: Lead[] = (leadsRaw ?? []).map((l) => ({
    ...l,
    campaign_month: l.campaign_id ? (campaignById[l.campaign_id]?.campaign_month ?? null) : null,
    campaign_niche: l.campaign_id ? (campaignById[l.campaign_id]?.niche ?? null) : null,
  }));

  const bookings: Record<string, { scheduled_at: string | null; booking_status: string }> = {};
  for (const b of bookingRows ?? []) if (!bookings[b.lead_id]) bookings[b.lead_id] = b;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <AddLeadButton />
      </div>
      <LeadsTable leads={leads ?? []} bookings={bookings} />
    </div>
  );
}
