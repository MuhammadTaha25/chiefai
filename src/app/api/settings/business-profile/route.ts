import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { isBusinessProfileComplete, sanitizeProducts, servicesText } from "@/lib/business-profile";
import { GOAL_OPTIONS, CTA_OPTIONS } from "@/lib/content-strategy";

const str = (v: unknown, n = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const strList = (v: unknown, n = 40) => (Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, n) : []);
const oneOf = (v: unknown, options: readonly { value: string }[]) => (options.some((o) => o.value === v) ? (v as string) : null);

export async function GET() {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("client_social_profile")
    .select("*")
    .eq("client_id", client.id)
    .maybeSingle();

  return NextResponse.json({
    company_name: client.company_name,
    icp_industry: client.icp_industry,
    icp_min_employees: client.icp_min_employees,
    icp_max_employees: client.icp_max_employees,
    icp_location: client.icp_location,
    landing_slug: client.landing_slug,
    profile: profile ?? null,
    complete: isBusinessProfileComplete(client, profile),
  });
}

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();

  let landingSlug: string | null = null;
  if (body.landing_slug) {
    landingSlug = String(body.landing_slug)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const products = sanitizeProducts(body.products);
  const productNames = new Set(products.map((p) => p.name));
  const companyName = str(body.company_name, 200);

  // company_name is not column-granted to browser sessions (harden_clients_privileges.sql), so it is
  // written with the service role — safe because client.id was resolved server-side from the session.
  if (companyName) {
    const { error: nameError } = await createAdminClient().from("clients").update({ company_name: companyName }).eq("id", client.id);
    if (nameError) return NextResponse.json({ error: nameError.message }, { status: 500 });
  }

  const { error: clientError } = await supabase
    .from("clients")
    .update({
      icp_industry: body.icp_industry || null,
      icp_min_employees: body.icp_min_employees ? Number(body.icp_min_employees) : null,
      icp_max_employees: body.icp_max_employees ? Number(body.icp_max_employees) : null,
      icp_location: body.icp_location || null,
      ...(landingSlug ? { landing_slug: landingSlug } : {}),
    })
    .eq("id", client.id);

  if (clientError?.message.includes("landing_slug")) {
    return NextResponse.json({ error: "That page URL is already taken — try another." }, { status: 409 });
  }

  if (clientError) {
    return NextResponse.json({ error: clientError.message }, { status: 500 });
  }

  const { error: profileError } = await supabase.from("client_social_profile").upsert(
    {
      client_id: client.id,
      niche: body.niche || null,
      language: body.language || null,
      posting_frequency: body.posting_frequency || null,
      emoji_style: body.emoji_style || null,
      content_pillars: body.content_pillars ?? [],
      tone_of_voice: body.tone_of_voice ?? [],
      target_audience: body.target_audience ?? [],
      preferred_ctas: body.preferred_ctas ?? [],
      caption_styles: body.caption_styles ?? [],
      pain_points: body.pain_points || null,
      negative_constraints: body.negative_constraints || null,
      brand_keywords: body.brand_keywords || null,
      business_description: body.business_description || null,
      // Structured products win; the free-text field is only a fallback for businesses that have none listed.
      services: products.length ? servicesText(products) : body.services || null,
      products,
      focus_products: strList(body.focus_products).filter((n) => productNames.has(n)),
      location: str(body.location, 300),
      desired_outcomes: str(body.desired_outcomes),
      why_choose_us: str(body.why_choose_us),
      proof: str(body.proof, 3000),
      tagline: str(body.tagline, 200),
      visual_style: str(body.visual_style, 500),
      brand_colors: strList(body.brand_colors, 10),
      primary_goal: oneOf(body.primary_goal, GOAL_OPTIONS),
      secondary_goal: oneOf(body.secondary_goal, GOAL_OPTIONS),
      primary_cta: oneOf(body.primary_cta, CTA_OPTIONS),
      cta_destination: str(body.cta_destination, 300),
      cta_phrase: str(body.cta_phrase, 200),
      faqs: body.faqs || null,
      usps: body.usps || null,
      offers: body.offers || null,
      pricing_info: body.pricing_info || null,
      must_say: body.must_say || null,
      must_not_say: body.must_not_say || null,
      contact_method: body.contact_method || null,
      booking_method: body.booking_method || null,
      business_hours: body.business_hours || null,
      website: body.website || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id" }
  );

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
