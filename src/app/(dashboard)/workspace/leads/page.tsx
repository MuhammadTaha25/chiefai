import { createClient } from "@/lib/supabase/server";
import { getWorkspaceLeads } from "@/lib/workspace-data";
import { LeadsPipelineView } from "@/components/workspace/LeadsPipelineView";

export default async function LeadsPage() {
  const supabase = await createClient();
  const leads = await getWorkspaceLeads(supabase);
  return <LeadsPipelineView leads={leads} />;
}
