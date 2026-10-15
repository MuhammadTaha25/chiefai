import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAMPLE_VALUES, renderCustomTemplate, unknownPlaceholders } from "@/lib/custom-template";
import { cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";

/** The client's own cold-email template (subject + body). Empty means "use the fixed template". */
export async function GET() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data } = await createAdminClient()
    .from("clients")
    .select("outreach_template_subject, outreach_template_body")
    .eq("id", client.id)
    .maybeSingle<{ outreach_template_subject: string | null; outreach_template_body: string | null }>();

  return NextResponse.json({
    ok: true,
    subject: data?.outreach_template_subject ?? "",
    body: data?.outreach_template_body ?? "",
  });
}

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";

  // Clearing the template falls back to the fixed one.
  if (!subject && !text) {
    await createAdminClient().from("clients").update({ outreach_template_subject: null, outreach_template_body: null }).eq("id", client.id);
    return NextResponse.json({ ok: true, issues: [] });
  }
  if (!subject || !text) return NextResponse.json({ error: "Write both a subject and a body, or clear both." }, { status: 400 });
  if (subject.length > 80 || text.length > 2000) return NextResponse.json({ error: "Subject max 80 characters, body max 2000." }, { status: 400 });

  const unknown = [...unknownPlaceholders(subject), ...unknownPlaceholders(text)];
  if (unknown.length) {
    return NextResponse.json({ error: `Unknown placeholder: ${[...new Set(unknown)].map((u) => `{${u}}`).join(", ")}. Use only first_name, company, industry, job_title, sender_company, website.` }, { status: 400 });
  }

  // The same deliverability lint the fixed template passes. A template that fails is not saved.
  const rendered = cleanOutreachEmail(renderCustomTemplate(subject, text, SAMPLE_VALUES));
  const issues = lintOutreachEmail(rendered);
  if (issues.length) {
    return NextResponse.json({ error: `This template would hurt deliverability: ${issues.join("; ")}`, issues }, { status: 400 });
  }

  const { error } = await createAdminClient()
    .from("clients")
    .update({ outreach_template_subject: subject, outreach_template_body: text })
    .eq("id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, issues: [] });
}
