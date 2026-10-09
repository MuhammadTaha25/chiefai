import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Onboarding intake, now handled in-app (previously forwarded to the n8n
 * `client-intake-supabase` workflow). The route path is kept only so the
 * onboarding page keeps working.
 *
 * Identity comes from the session; `zernioProfileId` and `sendingDomain` from
 * the request body are deliberately IGNORED — accepting them would let a user
 * bind their account to another tenant's Zernio profile or sending domain.
 * Those are only ever set by the server-side connect/provisioning flows.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!user.email) return NextResponse.json({ error: "Account has no email on file" }, { status: 400 });

  const verifyAdmin = createAdminClient();
  const { data: verification } = await verifyAdmin
    .from("signup_email_verifications")
    .select("status")
    .eq("email", user.email.trim().toLowerCase())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ status: string }>();
  if (verification?.status !== "verified") {
    return NextResponse.json({ error: "Please verify your email first", code: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const num = (v: unknown) => (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, 50) : []);

  const companyName = str(body.companyName, 200);
  if (!companyName) return NextResponse.json({ error: "companyName is required" }, { status: 400 });

  const admin = verifyAdmin;
  const { data: existing } = await admin.from("clients").select("id").eq("auth_user_id", user.id).maybeSingle<{ id: string }>();

  // Only fields actually present in the request are written, so a partial
  // re-submit never wipes previously saved values.
  const has = (k: string) => body[k] !== undefined;
  const fields: Record<string, unknown> = { company_name: companyName };
  if (has("icpIndustry")) fields.icp_industry = str(body.icpIndustry);
  if (has("icpMinEmployees")) fields.icp_min_employees = num(body.icpMinEmployees);
  if (has("icpMaxEmployees")) fields.icp_max_employees = num(body.icpMaxEmployees);
  if (has("icpLocation")) fields.icp_location = str(body.icpLocation);

  let clientId = existing?.id;
  if (clientId) {
    const { error } = await admin.from("clients").update(fields).eq("id", clientId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { data: created, error } = await admin
      .from("clients")
      .insert({ ...fields, auth_user_id: user.id, email: user.email })
      .select("id")
      .single<{ id: string }>();
    if (error || !created) return NextResponse.json({ error: "Could not create your account right now" }, { status: 500 });
    clientId = created.id;
    // No unique constraint on clients.auth_user_id, so simultaneous first submissions can each insert a row.
    // Keep the earliest row (same rule for every request) and remove ours if it is a later duplicate.
    const { data: mine } = await admin.from("clients").select("id, created_at").eq("auth_user_id", user.id).order("created_at", { ascending: true }).order("id", { ascending: true });
    if (mine && mine.length > 1 && mine[0].id !== created.id) {
      await admin.from("clients").delete().eq("id", created.id);
      clientId = mine[0].id;
      await admin.from("clients").update(fields).eq("id", clientId);
    }
  }

  const profile: Record<string, unknown> = {};
  if (has("niche")) profile.niche = str(body.niche);
  if (has("language")) profile.language = str(body.language);
  if (has("postingFrequency")) profile.posting_frequency = str(body.postingFrequency);
  if (has("emojiStyle")) profile.emoji_style = str(body.emojiStyle);
  if (has("contentPillars")) profile.content_pillars = list(body.contentPillars);
  if (has("toneOfVoice")) profile.tone_of_voice = list(body.toneOfVoice);
  if (has("targetAudience")) profile.target_audience = list(body.targetAudience);
  if (has("preferredCtas")) profile.preferred_ctas = list(body.preferredCtas);
  if (has("captionStyles")) profile.caption_styles = list(body.captionStyles);
  if (has("painPoints")) profile.pain_points = str(body.painPoints, 2000);
  if (has("negativeConstraints")) profile.negative_constraints = str(body.negativeConstraints, 2000);
  if (has("brandKeywords")) profile.brand_keywords = str(body.brandKeywords, 2000);
  const { error: profileError } = await admin
    .from("client_social_profile")
    .upsert({ client_id: clientId, ...profile, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  return NextResponse.json({ ok: true, client_id: clientId });
}
