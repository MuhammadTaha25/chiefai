import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAMPLE_VALUES, renderCustomTemplate, unknownPlaceholders } from "@/lib/custom-template";
import { cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";

type Params = { params: Promise<{ campaignId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { campaignId } = await params;
  const admin = createAdminClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("template_subject, template_body, client_id")
    .eq("id", campaignId)
    .eq("client_id", client.id)
    .maybeSingle<{ template_subject: string | null; template_body: string | null; client_id: string }>();

  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  // Return client-level defaults so UI can show them as placeholders
  const { data: clientRow } = await admin
    .from("clients")
    .select("outreach_template_subject, outreach_template_body")
    .eq("id", client.id)
    .maybeSingle<{ outreach_template_subject: string | null; outreach_template_body: string | null }>();

  return NextResponse.json({
    ok: true,
    subject: campaign.template_subject ?? "",
    body: campaign.template_body ?? "",
    clientDefault: {
      subject: clientRow?.outreach_template_subject ?? "",
      body: clientRow?.outreach_template_body ?? "",
    },
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { campaignId } = await params;
  const admin = createAdminClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string }>();

  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";

  // Clearing falls back to client-level template
  if (!subject && !text) {
    await admin.from("campaigns").update({ template_subject: null, template_body: null }).eq("id", campaignId);
    return NextResponse.json({ ok: true });
  }

  if (!subject || !text) return NextResponse.json({ error: "Write both a subject and a body, or clear both." }, { status: 400 });
  if (subject.length > 80 || text.length > 2000) return NextResponse.json({ error: "Subject max 80 chars, body max 2000." }, { status: 400 });

  const unknown = [...unknownPlaceholders(subject), ...unknownPlaceholders(text)];
  if (unknown.length) {
    return NextResponse.json({
      error: `Unknown placeholder: ${[...new Set(unknown)].map((u) => `{${u}}`).join(", ")}. Use only first_name, company, industry, job_title, sender_company, website.`,
    }, { status: 400 });
  }

  const rendered = cleanOutreachEmail(renderCustomTemplate(subject, text, SAMPLE_VALUES));
  const issues = lintOutreachEmail(rendered);
  if (issues.length) {
    return NextResponse.json({ error: `Template failed deliverability check: ${issues.join("; ")}`, issues }, { status: 400 });
  }

  const { error } = await admin.from("campaigns").update({ template_subject: subject, template_body: text }).eq("id", campaignId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
