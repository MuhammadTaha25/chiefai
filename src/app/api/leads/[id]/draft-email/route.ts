import { createAdminClient } from "@/lib/supabase/admin";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { draftAidaEmail } from "@/lib/gemini";
import { renderCustomTemplate } from "@/lib/custom-template";
import { bareDomain } from "@/lib/outreach-template";
import { cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";
import { withUnsubscribeFooter } from "@/lib/compliance";

/**
 * Drafts (does NOT send) an AIDA cold email for one lead using Gemini,
 * grounded in the client's own "what do you sell" answer from their most
 * recent lead-gen intake form. Preview-only — /send-email actually sends.
 *
 * Add `?mode=ai` to skip the saved template and write the email with the AI. The response also carries the
 * `footer` that /send-email appends (unsubscribe line), so the preview shows exactly what the lead will read,
 * and `source` ("template" | "ai") so the page can say where the text came from.
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

  const admin = createAdminClient();
  const context = await getClientBusinessContext(admin, client.id);
  const forceAi = new URL(req.url).searchParams.get("mode") === "ai";
  // Same footer /send-email appends to the body, shown read-only under the editable text in the preview.
  const footer = withUnsubscribeFooter("", {
    company: client.company_name,
    postalAddress: (client as { postal_address?: string | null }).postal_address,
  }).replace(/^\s+/, "");

  // The client's own saved template comes first, when it passes the same deliverability lint the sender uses.
  const { data: clientRow } = await admin
    .from("clients")
    .select("outreach_template_subject, outreach_template_body")
    .eq("id", client.id)
    .maybeSingle<{ outreach_template_subject: string | null; outreach_template_body: string | null }>();
  if (!forceAi && clientRow?.outreach_template_subject && clientRow?.outreach_template_body) {
    const custom = cleanOutreachEmail(
      renderCustomTemplate(clientRow.outreach_template_subject, clientRow.outreach_template_body, {
        // Same rule as the automatic sender: a directory lead's "name" is its company name, so greet generically.
        first_name: !lead.job_title || (lead.name ?? "").trim().toLowerCase() === (lead.company ?? "").trim().toLowerCase() ? null : lead.name,
        company: lead.company,
        industry: null,
        job_title: lead.job_title ?? null,
        sender_company: client.company_name ?? "us",
        website: bareDomain(context.website),
      })
    );
    if (lintOutreachEmail(custom).length === 0) {
      return NextResponse.json({
        ...custom,
        footer,
        source: "template",
        notice:
          "This text comes from the email template saved on your Campaigns page, not from the AI. It does not adapt to the lead or to your latest campaign, so check that it still fits.",
      });
    }
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
      businessContext: formatBusinessContext(context),
      sellingDescription,
      senderCompany: client.company_name ?? "us",
      leadName: lead.name || "there",
      leadCompany: lead.company || "your company",
      leadTitle: lead.job_title,
    });
    return NextResponse.json({ ...draft, footer, source: "ai" });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("GEMINI_API_KEY is not set")) {
      return NextResponse.json(
        { error: "AI drafting is not set up on this server yet. Save your own email template on the Campaigns page, or ask for the Gemini key to be added." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
