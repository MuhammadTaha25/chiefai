import { createClient } from "@/lib/supabase/server";
import PipelineBoard from "@/components/pipeline-board";
import { stageForLead, type PipelineLeadInput, type PipelineStageId } from "@/lib/pipeline-stage";

interface ProposalWithLead {
  id: string;
  lead_id: string | null;
  amount: number | null;
  status: string;
  sent_at: string;
  decided_at: string | null;
  leads: { name: string | null; company: string | null } | null;
}

export default async function PipelinePage() {
  const supabase = await createClient();

  const { data: proposals } = await supabase
    .from("proposals")
    .select("id, lead_id, amount, status, sent_at, decided_at, leads(name, company)")
    .order("sent_at", { ascending: false })
    .returns<ProposalWithLead[]>();

  // Outreach leads sit on the board according to what really happened (email sent, reply, booking, bounce,
  // unsubscribe). RLS scopes this to the signed-in client's own leads.
  const { data: contacted } = await supabase
    .from("leads")
    .select(
      "id, name, company, email, status, follow_up_number, last_contact_at, reply_received, reply_classification, booked, unsubscribed, email_bounced, complained, manually_stopped"
    )
    .or("last_contact_at.not.is.null,follow_up_number.gte.1,reply_received.eq.true")
    .order("last_contact_at", { ascending: false, nullsFirst: false })
    .limit(300)
    .returns<(PipelineLeadInput & { id: string; name: string | null; company: string | null; email: string | null; last_contact_at: string | null })[]>();

  const proposalLeadIds = new Set((proposals ?? []).map((p) => p.lead_id).filter(Boolean));
  const outreach = (contacted ?? [])
    .filter((l) => !proposalLeadIds.has(l.id))
    .flatMap((l) => {
      const s = stageForLead(l);
      return s
        ? [{ id: l.id, name: l.name, company: l.company, email: l.email, stage: s.stage as PipelineStageId, detail: s.detail, at: l.last_contact_at }]
        : [];
    });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
      <p className="text-sm text-zinc-500">
        Contacted leads move through the stages on their own as emails are sent, replies come in and meetings are
        booked. Deals with an amount can be dragged between stages; moving one to Won creates a project automatically.
      </p>
      <PipelineBoard proposals={proposals ?? []} outreach={outreach} />
    </div>
  );
}
