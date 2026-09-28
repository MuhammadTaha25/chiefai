import { createAdminClient } from "@/lib/supabase/admin";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { draftAidaEmail } from "@/lib/gemini";

/**
 * Drafts (does NOT send) an AIDA cold email for one lead using Gemini,
 * grounded in the client's own "what do you sell" answer from their most
 * recent lead-gen intake form. Preview-only — /send-email actually sends.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: lead } = await supabase
    .from("leads")
    .select("id, name, company, job_title")
    .eq("id", leadId)
    .eq("client_id", client.id)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const { data: job } = await supabase
    .from("lead_gen_jobs")
    .select("criteria")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ criteria: Record<string, unknown> }>();

  const sellingDescription = (job?.criteria?.what_you_sell as string | undefined)?.trim();
  if (!sellingDescription) {
    return NextResponse.json(
      { error: "Fill out the \"What do you sell?\" question in Find leads first — the AI needs it to write emails" },
      { status: 400 }
    );
  }

  try {
    const draft = await draftAidaEmail({
      businessContext: formatBusinessContext(await getClientBusinessContext(createAdminClient(), client.id)),
      sellingDescription,
      senderCompany: client.company_name ?? "us",
      leadName: lead.name || "there",
      leadCompany: lead.company || "your company",
      leadTitle: lead.job_title,
    });
    return NextResponse.json(draft);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
