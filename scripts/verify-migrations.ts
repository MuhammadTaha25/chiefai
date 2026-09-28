/**
 * Verifies the Phase 3 SQL migrations were actually applied to the live database
 * (behaviourally, via PostgREST - DDL cannot be inspected without a DB URL).
 * Run:  npx tsx scripts/verify-migrations.ts   Creates and removes its own temp rows.
 */
import * as fs from "fs"; import * as path from "path";
for (const l of fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const email = `verify-mig-${Date.now()}@example.com`, password = "Vm!" + Math.random().toString(36).slice(2) + "Aa1";
  const { data: u } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: c } = await admin.from("clients").insert({ auth_user_id: u.user!.id, company_name: "verify-mig", email, status: "inactive" }).select("id").single();
  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } }); await sb.auth.signInWithPassword({ email, password });
    const esc = await sb.from("clients").update({ status: "active" }).eq("id", c!.id).select("id");
    console.log("harden_clients_privileges.sql :", esc.data?.length ? "NOT APPLIED (user can edit status)" : "APPLIED");
    const a = await admin.from("leads").insert({ client_id: c!.id, email: "Dup@Example.com", status: "new" });
    const b = await admin.from("leads").insert({ client_id: c!.id, email: "dup@example.com", status: "new" });
    console.log("add_leads_unique_email.sql    :", b.error?.code === "23505" ? "APPLIED (duplicate rejected)" : "NOT APPLIED (duplicate accepted)"); void a;
    const ad = await admin.from("ad_campaigns").insert({ client_id: c!.id, platform: "meta_ads", status: "generating", goal: "Leads", business_name: "v", business_description: "v", target_location: "v", daily_budget: 1 }).select("id").single();
    const p = await admin.from("ad_campaigns").update({ status: "paused" }).eq("id", ad.data!.id);
    console.log("fix_ad_campaigns_status_check_v3.sql:", p.error ? "NOT APPLIED" : "APPLIED");
    // harden_client_phone_numbers.sql: the same number must not be ACTIVE for two tenants.
    const { data: c2 } = await admin.from("clients").insert({ company_name: "verify-mig-2", email: "verify-mig-2-" + Date.now() + "@example.com" }).select("id").single();
    try {
      await admin.from("client_phone_numbers").insert({ client_id: c!.id, twilio_number: "+15550990001", twilio_sid: "PN_VERIFY_1", status: "active" });
      const dupNum = await admin.from("client_phone_numbers").insert({ client_id: c2!.id, twilio_number: "+15550990001", twilio_sid: "PN_VERIFY_2", status: "active" });
      console.log("harden_client_phone_numbers.sql:", dupNum.error?.code === "23505" ? "APPLIED (duplicate active number rejected)" : "NOT APPLIED (same number can be active for two tenants)");
    } finally { await admin.from("client_phone_numbers").delete().in("client_id", [c!.id, c2!.id]); await admin.from("clients").delete().eq("id", c2!.id); }
  } finally {
    await admin.from("client_phone_numbers").delete().eq("client_id", c!.id); await admin.from("ad_campaigns").delete().eq("client_id", c!.id); await admin.from("leads").delete().eq("client_id", c!.id); await admin.from("clients").delete().eq("id", c!.id); await admin.auth.admin.deleteUser(u.user!.id); }
})().catch((e) => console.log("FATAL", e.message));
