import { NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAMPLE_VALUES, renderCustomTemplate } from "@/lib/custom-template";
import { cleanOutreachEmail } from "@/lib/email-quality";
import { buildTemplateEmail } from "@/lib/outreach-template";
import { draftAidaEmail } from "@/lib/gemini";

/**
 * Returns what the outgoing cold email will actually look like for a sample lead.
 * Priority: custom template (if set) > AIDA AI draft > fixed template.
 * This is read-only and generates no spend.
 */
export async function GET() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createAdminClient();

  const { data: clientRow } = await admin
    .from("clients")
    .select("outreach_template_subject, outreach_template_body, company_name, website, what_you_sell")
    .eq("id", client.id)
    .maybeSingle<{
      outreach_template_subject: string | null;
      outreach_template_body: string | null;
      company_name: string | null;
      website: string | null;
      what_you_sell: string | null;
    }>();

  const senderCompany = clientRow?.company_name ?? "Your Company";
  const sellingDescription = clientRow?.what_you_sell ?? "";

  // 1. Custom template takes priority if set.
  if (clientRow?.outreach_template_subject && clientRow?.outreach_template_body) {
    const rendered = cleanOutreachEmail(
      renderCustomTemplate(clientRow.outreach_template_subject, clientRow.outreach_template_body, {
        ...SAMPLE_VALUES,
        sender_company: senderCompany,
        website: clientRow.website ? clientRow.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "") : SAMPLE_VALUES.website,
      })
    );
    return NextResponse.json({ ok: true, source: "custom", ...rendered });
  }

  // 2. AIDA AI draft when the client has described what they sell.
  if (sellingDescription) {
    try {
      const rendered = cleanOutreachEmail(
        await draftAidaEmail({
          sellingDescription,
          senderCompany,
          leadName: SAMPLE_VALUES.first_name ?? "Sam",
          leadCompany: SAMPLE_VALUES.company ?? "Acme Dental",
          leadTitle: SAMPLE_VALUES.job_title ?? null,
        })
      );
      return NextResponse.json({ ok: true, source: "aida", ...rendered });
    } catch {
      // Fall through to fixed template if AI fails.
    }
  }

  // 3. Fixed template fallback.
  const rendered = cleanOutreachEmail(
    buildTemplateEmail({
      firstName: SAMPLE_VALUES.first_name ?? null,
      leadCompany: SAMPLE_VALUES.company ?? "Acme Dental",
      industry: SAMPLE_VALUES.industry ?? null,
      jobTitle: SAMPLE_VALUES.job_title ?? null,
      offer: "grow their business with targeted outreach and automation",
      benefit: "more qualified leads without manual prospecting",
      senderCompany,
      website: clientRow?.website ?? null,
    })
  );
  return NextResponse.json({ ok: true, source: "fixed", ...rendered });
}
