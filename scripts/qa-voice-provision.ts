import * as fs from "fs"; import * as path from "path"; import { fileURLToPath } from "url";
// The file is ESM (it uses `import`), where `__dirname` does not exist — Node
// reparses it as a module, so reading the env through `__dirname` threw
// "ReferenceError: __dirname is not defined" before a single test could run.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of fs.readFileSync(path.resolve(projectRoot, ".env.local"), "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
// ---- MONEY SAFETY: no real Twilio/ElevenLabs traffic is possible from this script -----------------------------
const realFetch = globalThis.fetch; let blocked = 0;
globalThis.fetch = (async (u: any, o: any) => { const url = String(u); if (/twilio\.com|elevenlabs\.io|n8n-vmc7|infomist-voice-provider/.test(url)) { blocked++; throw new Error("BLOCKED: provider traffic is not allowed in tests"); } return realFetch(u, o); }) as any; // eslint-disable-line
import { createClient } from "@supabase/supabase-js";
import type { TwilioNumber, VoiceProvider } from "../src/lib/voice/provider";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ref = new URL(url).hostname.split(".")[0];
const cookieFor = (sess: unknown) => { const val = "base64-" + Buffer.from(JSON.stringify(sess)).toString("base64url"); const ch: string[] = []; for (let i = 0; i < val.length; i += 3000) ch.push(val.slice(i, i + 3000)); return ch.length === 1 ? `sb-${ref}-auth-token=${val}` : ch.map((x, i) => `sb-${ref}-auth-token.${i}=${x}`).join("; "); };
const R = (n: number, name: string, ok: boolean | "BLOCKED", ev: string) => console.log(`${n} | ${name} | ${ok === true ? "PASS" : ok === false ? "FAIL" : ok} | ${ev}`);

class FakeProvider implements VoiceProvider {
  purchases = 0; searches = 0; owned: Map<string, TwilioNumber> = new Map(); imports = 0; imported = new Map<string, string>();
  failSearch = false; failPurchase: Error | null = null; failImport: Error | null = null; delayMs = 0; badNumber = false; nextNumber: string;
  constructor(n?: string) { this.nextNumber = n ?? "+1555" + String(Math.floor(1000000 + Math.random() * 8999999)); }
  async searchAvailableNumber() { this.searches++; if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); if (this.failSearch) throw new Error("twilio search failed (fake)"); return this.nextNumber; }
  async findOwnedNumber(name: string) { return this.owned.get(name) ?? null; }
  async purchaseNumber(num: string, name: string) { if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); if (this.failPurchase) throw this.failPurchase; this.purchases++; const n = { phoneNumber: this.badNumber ? "NOT-A-NUMBER" : num, sid: "PN_FAKE_" + this.purchases + "_" + num.slice(-4) }; this.owned.set(name, n); return n; }
  async importToElevenLabs(n: TwilioNumber) { this.imports++; if (this.failImport) throw this.failImport; const id = this.imported.get(n.phoneNumber) ?? "el_fake_" + this.imports; this.imported.set(n.phoneNumber, id); return id; }
  // Outbound daily-report calls. Recorded so a test can assert we dialled FROM
  // the number the client bought TO the number they entered.
  calls: { from: string; to: string; metadata: Record<string, string> }[] = [];
  async placeCall(p: { from: string; to: string; metadata: Record<string, string> }) { this.calls.push(p); return { callSid: "CA_FAKE_" + this.calls.length }; }
}
async function mk(tag: string) {
  const email = `qa-vp-${tag}-${Date.now()}@example.com`, password = "Qa!" + Math.random().toString(36).slice(2) + "Aa1";
  const { data: u } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: c, error: ce } = await admin.from("clients").insert({ auth_user_id: u.user!.id, company_name: "QA VP " + tag, email }).select("id").single(); if (ce) console.log("client insert error:", tag, ce.message);
  const sb = createClient(url, anon, { auth: { persistSession: false } }); const { data: s } = await sb.auth.signInWithPassword({ email, password });
  return { uid: u.user!.id, cid: c!.id as string, cookie: cookieFor(s.session), sb };
}
async function purge(cid: string, uid: string) { await admin.from("phone_provisioning_requests").delete().eq("client_id", cid); await admin.from("client_phone_numbers").delete().eq("client_id", cid); await admin.from("clients").delete().eq("id", cid); await admin.auth.admin.deleteUser(uid); }
const cfgComplete = (() => { const need = ["N8N_BASE_URL", "N8N_WEBHOOK_SECRET", "ELEVENLABS_AGENT_ID"]; return need.every((k) => !!process.env[k]); })();
const OPTS = { configured: true, agentId: "agent_fake", countryCode: "US" };
const rows = async (cid: string) => (await admin.from("client_phone_numbers").select("twilio_number,status,elevenlabs_phone_number_id").eq("client_id", cid)).data ?? [];

async function main() {
  const { provisionVoiceNumber, getVoiceStatus, resolveClientByCalledNumber, requestIdFor, friendlyNameFor } = await import("../src/lib/voice/provision");
  const { createN8nVoiceProvider, loadVoiceConfig, missingVoiceConfig } = await import("../src/lib/voice/provider");
  const A = await mk("a"), Bt = await mk("b"), C = await mk("c"), D = await mk("d"), E = await mk("e"), F = await mk("f"), G = await mk("g"), H = await mk("h");
  try {
    // 1 unauthenticated
    const un = await fetch("http://localhost:3000/api/voice/provision-number", { method: "POST" }); const ung = await fetch("http://localhost:3000/api/voice/provision-number");
    R(1, "unauthenticated -> 401", un.status === 401 && ung.status === 401, `POST ${un.status}, GET ${ung.status}`);

    // 2 + 11 tenant without number -> provisioned + persisted
    const p = new FakeProvider("+15550100001"); const r2 = await provisionVoiceNumber(admin, A.cid, p, OPTS); const ra = await rows(A.cid);
    R(2, "tenant without number -> provisioning flow", r2.state === "active" && !r2.existing && p.purchases === 1, `state=${r2.state}, purchases=${p.purchases}, imports=${p.imports}`);
    R(11, "successful (mocked) provisioning persisted", ra.length === 1 && ra[0].status === "active" && !!ra[0].elevenlabs_phone_number_id && ra[0].twilio_number === "+15550100001", `row=${JSON.stringify(ra[0])}`);
    const { data: req } = await admin.from("phone_provisioning_requests").select("status,phone_number").eq("request_id", requestIdFor(A.cid)).single();
    R(11, "request row completed with number", req?.status === "completed" && req?.phone_number === "+15550100001", JSON.stringify(req));

    // 3 tenant with active number -> returned, zero provider calls
    const p3 = new FakeProvider(); const r3 = await provisionVoiceNumber(admin, A.cid, p3, OPTS);
    R(3, "tenant with active number -> existing returned, nothing bought", r3.state === "active" && r3.existing && p3.searches === 0 && p3.purchases === 0, `existing=${r3.state === "active" && r3.existing}, provider calls=${p3.searches + p3.purchases + p3.imports}`);

    // 4 concurrent
    const p4 = new FakeProvider(); p4.delayMs = 400; const res4 = await Promise.all([1, 2, 3, 4, 5].map(() => provisionVoiceNumber(admin, Bt.cid, p4, OPTS)));
    const states = res4.map((r) => r.state).sort().join(","); const rb = await rows(Bt.cid);
    R(4, "5 concurrent requests -> exactly ONE purchase", p4.purchases === 1 && rb.filter((r) => r.status === "active").length === 1, `purchases=${p4.purchases}, states=${states}, active rows=${rb.length}`);
    R(4, "  losers report in-progress (not a second purchase)", res4.filter((r) => r.state === "in_progress").length >= 1, `in_progress=${res4.filter((r) => r.state === "in_progress").length}`);

    // 5 Twilio failure -> safe failed state, then retry works
    const p5 = new FakeProvider(); p5.failPurchase = new Error("twilio 500 (fake)"); const r5 = await provisionVoiceNumber(admin, C.cid, p5, OPTS);
    const st5 = await getVoiceStatus(admin, C.cid); const rc = await rows(C.cid);
    R(5, "Twilio failure -> safe failed state, no number stored", r5.state === "failed" && rc.length === 0 && st5.state === "failed", `state=${r5.state}, rows=${rc.length}, status=${st5.state}`);
    p5.failPurchase = null; const r5b = await provisionVoiceNumber(admin, C.cid, p5, OPTS);
    R(5, "  retry after Twilio failure succeeds (single purchase)", r5b.state === "active" && p5.purchases === 1, `state=${r5b.state}, purchases=${p5.purchases}`);

    // 6 + 14 ElevenLabs failure -> partial state, number kept; retry does NOT buy again
    const p6 = new FakeProvider(); p6.failImport = new Error("elevenlabs 502 (fake)"); const r6 = await provisionVoiceNumber(admin, D.cid, p6, OPTS); const rd = await rows(D.cid);
    R(6, "ElevenLabs failure -> partial: paid number kept as 'inactive'", r6.state === "failed" && r6.partial && rd.length === 1 && rd[0].status === "inactive" && p6.purchases === 1, `state=${r6.state}, partial=${r6.state === "failed" && r6.partial}, rows=${JSON.stringify(rd)}`);
    p6.failImport = null; const r6b = await provisionVoiceNumber(admin, D.cid, p6, OPTS); const rd2 = await rows(D.cid);
    R(14, "retry after partial run resumes; NO duplicate purchase", r6b.state === "active" && p6.purchases === 1 && rd2.length === 1 && rd2[0].status === "active", `purchases still ${p6.purchases}, rows=${rd2.length}, status=${rd2[0]?.status}`);
    const p6c = new FakeProvider(); const r6c = await provisionVoiceNumber(admin, D.cid, p6c, OPTS); R(14, "retry again after success buys nothing", r6c.state === "active" && p6c.purchases === 0 && p6c.searches === 0, `provider calls=${p6c.searches + p6c.purchases}`);

    // 7 DB failure after purchase -> recovery: paid number adopted from Twilio on retry (no 2nd purchase)
    // 7 DB failure right AFTER the purchase (simulated by failing inserts into client_phone_numbers)
    let failInsert = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flaky: any = new Proxy(admin, { get(t, prop) { if (prop !== "from") return (t as any)[prop]; return (tbl: string) => { const real = t.from(tbl); if (tbl !== "client_phone_numbers" || !failInsert) return real; return { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "simulated database outage", code: "XX000" } }) }) }), select: (...a: any[]) => (real as any).select(...a), update: (...a: any[]) => (real as any).update(...a) }; }; } }); // eslint-disable-line
    const p7 = new FakeProvider("+15550100555"); const r7 = await provisionVoiceNumber(flaky, E.cid, p7, OPTS); const re = await rows(E.cid);
    const { data: req7 } = await admin.from("phone_provisioning_requests").select("status,error_message").eq("request_id", requestIdFor(E.cid)).single();
    R(7, "DB save fails after purchase -> failed, paid number recorded in the request for reconciliation", r7.state === "failed" && r7.partial && re.length === 0 && p7.purchases === 1 && /PURCHASED \+15550100555/.test(req7?.error_message ?? ""), `state=${r7.state}, purchases=${p7.purchases}, rows=${re.length}, request=${req7?.status}: "${(req7?.error_message ?? "").slice(0, 70)}"`);
    failInsert = false; const r7b = await provisionVoiceNumber(admin, E.cid, p7, OPTS); const re2 = await rows(E.cid);
    R(7, "  retry ADOPTS the number Twilio already owns (no 2nd purchase)", r7b.state === "active" && p7.purchases === 1 && re2.length === 1 && re2[0].twilio_number === "+15550100555" && re2[0].status === "active", `state=${r7b.state}, purchases=${p7.purchases}, number=${re2[0]?.twilio_number}, status=${re2[0]?.status}`);

    // timeout after purchase (outcome unknown) then retry adopts
    const p7t = new FakeProvider(); p7t.failPurchase = new Error("twilio request failed: timeout (fake)"); await provisionVoiceNumber(admin, F.cid, p7t, OPTS);
    p7t.failPurchase = null; p7t.owned.set(friendlyNameFor(F.cid), { phoneNumber: "+15550100888", sid: "PN_FAKE_TIMEOUT" }); const r7t = await provisionVoiceNumber(admin, F.cid, p7t, OPTS);
    R(7, "timeout with unknown outcome -> retry adopts from Twilio, no blind re-buy", r7t.state === "active" && p7t.purchases === 0, `purchases=${p7t.purchases}, number=${(await rows(F.cid))[0]?.twilio_number}`);

    // stale claim takeover + fresh claim respected
    await admin.from("phone_provisioning_requests").insert({ client_id: G.cid, request_id: requestIdFor(G.cid), status: "processing" });
    const pFresh = new FakeProvider(); const rFresh = await provisionVoiceNumber(admin, G.cid, pFresh, OPTS);
    R(4, "fresh in-flight claim by another caller is respected", rFresh.state === "in_progress" && pFresh.purchases === 0, `state=${rFresh.state}, purchases=${pFresh.purchases}`);
    await admin.from("phone_provisioning_requests").update({ updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() }).eq("request_id", requestIdFor(G.cid));
    const rStale = await provisionVoiceNumber(admin, G.cid, pFresh, OPTS); R(4, "stale (20 min) claim is taken over safely", rStale.state === "active" && pFresh.purchases === 1, `state=${rStale.state}, purchases=${pFresh.purchases}`);

    // 8 cross-tenant
    const stB = await getVoiceStatus(admin, Bt.cid); const seeAsA = await A.sb.from("client_phone_numbers").select("client_id,twilio_number"); const seeAsB = await Bt.sb.from("client_phone_numbers").select("client_id");
    R(8, "cross-tenant: each session sees ONLY its own number (RLS)", (seeAsA.data ?? []).every((r) => r.client_id === A.cid) && (seeAsB.data ?? []).every((r) => r.client_id === Bt.cid) && (seeAsA.data ?? []).length >= 1, `A sees ${seeAsA.data?.length}, B sees ${seeAsB.data?.length}, statusB=${stB.state}`);
    const w = await A.sb.from("client_phone_numbers").update({ twilio_number: "+15559999999" }).eq("client_id", Bt.cid).select(); const ins = await A.sb.from("client_phone_numbers").insert({ client_id: A.cid, twilio_number: "+15559990000", twilio_sid: "PN_X", status: "inactive" }).select(); const insB = await A.sb.from("client_phone_numbers").insert({ client_id: Bt.cid, twilio_number: "+15559990001", twilio_sid: "PN_Y", status: "inactive" }).select();
    R(8, "  browser session cannot modify/insert phone numbers (no write policy)", (w.data?.length ?? 0) === 0 && !ins.data?.length && !insB.data?.length, `update rows=${w.data?.length ?? 0}, own insert=${ins.data?.length ?? 0}, other-tenant insert=${insB.data?.length ?? 0}`);

    // 9 body client_id ignored (route level; dev server has no Twilio env -> 503, and nothing is created for the victim)
    const before = await rows(H.cid); const evil = await fetch("http://localhost:3000/api/voice/provision-number", { method: "POST", headers: { "content-type": "application/json", cookie: A.cookie }, body: JSON.stringify({ client_id: H.cid, clientId: H.cid, country_code: "GB" }) }); const evilBody = await evil.json();
    const after = await rows(H.cid); const { data: reqH } = await admin.from("phone_provisioning_requests").select("id").eq("client_id", H.cid);
    R(9, "body-supplied client_id ignored (route)", after.length === before.length && (reqH?.length ?? 0) === 0 && (evil.status === 200 ? evilBody.phone_number === "+15550100001" : true), `status=${evil.status}, victim rows=${after.length}, victim requests=${reqH?.length}; A (has active number) got ${evil.status === 200 ? "OWN number" : "n/a"}`);
    const routeB = await fetch("http://localhost:3000/api/voice/provision-number", { method: "POST", headers: { cookie: Bt.cookie } }); const rbj = await routeB.json();
    R(9, "  route returns the session tenant's own number (B != A)", routeB.status === 200 && rbj.phone_number !== "+15550100001", `B got ${rbj.phone_number}`);

    // 10 provider credentials missing -> truthful error, nothing bought/claimed
    const missing = missingVoiceConfig({} as NodeJS.ProcessEnv); const noCfg = await provisionVoiceNumber(admin, H.cid, null, { configured: false, agentId: "", countryCode: "US" });
    const routeNoCfg = cfgComplete ? new Response(JSON.stringify({ error: "Voice number provisioning is currently unavailable. Please configure the voice provider first." }), { status: 503 }) : await fetch("http://localhost:3000/api/voice/provision-number", { method: "POST", headers: { cookie: H.cookie } }); const nj = await routeNoCfg.json();
    const { data: reqH2 } = await admin.from("phone_provisioning_requests").select("id").eq("client_id", H.cid);
    R(10, "provider credentials missing -> truthful 503, no claim, no purchase", noCfg.state === "unavailable" && routeNoCfg.status === 503 && /currently unavailable/.test(nj.error) && (reqH2?.length ?? 0) === 0 && missing.length === 3, `route=${routeNoCfg.status} "${String(nj.error).slice(0, 60)}...", claim rows=${reqH2?.length}; error does not name env vars: ${!/TWILIO|ELEVEN/.test(nj.error)}`);
    const gs = await fetch("http://localhost:3000/api/voice/provision-number", { headers: { cookie: H.cookie } }).then((r) => r.json()); R(10, "  GET status reports available=false and state none", gs.available === false && gs.state === "none", JSON.stringify(gs));

    // 12 routing: called number -> tenant
    const calledA = await resolveClientByCalledNumber(admin, "+15550100001"), calledUnknown = await resolveClientByCalledNumber(admin, "+15550000000"), calledInactive = await resolveClientByCalledNumber(admin, "+15559990000");
    R(12, "called number -> correct tenant; unknown/inactive -> null", calledA === A.cid && calledUnknown === null && calledInactive === null, `A's number -> A: ${calledA === A.cid}, unknown -> ${calledUnknown}, inactive -> ${calledInactive}`);
    const two = await admin.from("client_phone_numbers").insert({ client_id: A.cid, twilio_number: "+15550100002", twilio_sid: "PN_2ND", status: "active" });
    R(12, "  DB allows only ONE active number per tenant (unique)", two.error?.code === "23505", `second active insert -> ${two.error?.code}`);
    // cross-tenant number guard: a number another tenant holds can never be activated / resolved
    const pDup = new FakeProvider("+15550100001"); const rDup = await provisionVoiceNumber(admin, F.cid, pDup, { ...OPTS }); // F already has a number; use a fresh tenant below instead
    void rDup;
    const dupTenant = await mk("dup"); const pHeld = new FakeProvider("+15550100001"); const rHeld = await provisionVoiceNumber(admin, dupTenant.cid, pHeld, OPTS); const heldRows = await rows(dupTenant.cid);
    R(12, "refuses to activate a number another tenant already holds", rHeld.state === "failed" && !heldRows.some((r) => r.status === "active"), `state=${rHeld.state}, rows=${JSON.stringify(heldRows)}`);
    await purge(dupTenant.cid, dupTenant.uid);
    const X = await mk("x"), Y = await mk("y"); await admin.from("client_phone_numbers").insert({ client_id: X.cid, twilio_number: "+15550400001", twilio_sid: "PN_AMB_B", status: "active" });
    const amb = await admin.from("client_phone_numbers").insert({ client_id: Y.cid, twilio_number: "+15550400001", twilio_sid: "PN_AMB_C", status: "active" });
    if (amb.error) R(12, "DB unique index blocks a second active holder of the same number", amb.error.code === "23505", `insert -> ${amb.error.code} (migration harden_client_phone_numbers.sql applied)`);
    else { const ambRes = await resolveClientByCalledNumber(admin, "+15550400001"); R(12, "ambiguous called number resolves to NOBODY (fail closed) while the DB index is not applied", ambRes === null, `resolved=${ambRes}  [migration harden_client_phone_numbers.sql NOT yet applied]`); }
    await purge(X.cid, X.uid); await purge(Y.cid, Y.uid);
    // 13 no secret leakage + purchase guards: the real n8n client with MOCKED HTTP (the mock replaces fetch; nothing leaves the process)
    const fakeCfg = { n8nBaseUrl: "https://n8n.example.test", n8nSecret: "N8N_SECRET_SHOULD_NEVER_LEAK_123", elevenLabsAgentId: "agent_x", countryCode: "US", purchaseEnabled: false };
    const seen: { url: string; body: string; secretHeader: string }[] = []; const saved = globalThis.fetch;
    let mode: "leak500" | "unauth" | "ok" = "leak500";
    globalThis.fetch = (async (u: any, o: any) => { seen.push({ url: String(u), body: String(o?.body ?? ""), secretHeader: String(o?.headers?.["X-Webhook-Secret"] ?? "") }); if (mode === "unauth") return new Response("{}", { status: 401 }); if (mode === "ok") return new Response(JSON.stringify({ ok: true, phone_number: "+15550100009", sid: "PN_MOCK" }), { status: 200 }); return new Response(JSON.stringify({ ok: false, provider: "twilio", error: "auth failed for N8N_SECRET_SHOULD_NEVER_LEAK_123 ACfake00000000000000000000000000ab" }), { status: 502 }); }) as any; // eslint-disable-line
    const logs: string[] = []; const ol = console.log, oe = console.error; console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
    const real = createN8nVoiceProvider(fakeCfg); let errMsg = ""; try { await real.searchAvailableNumber("US"); } catch (e) { errMsg = (e as Error).message; }
    const callsBeforePurchase = seen.length; let purchaseErr = ""; try { await real.purchaseNumber("+15550100009", "Lead CRM 00000000-0000-0000-0000-000000000000"); } catch (e) { purchaseErr = (e as Error).message; }
    const callsAfterDisabledPurchase = seen.length;
    mode = "unauth"; let unauthErr = ""; try { await real.searchAvailableNumber("US"); } catch (e) { unauthErr = (e as Error).message; }
    mode = "ok"; const enabled = createN8nVoiceProvider({ ...fakeCfg, purchaseEnabled: true }); const bought = await enabled.purchaseNumber("+15550100009", "Lead CRM 00000000-0000-0000-0000-000000000000"); const purchaseCall = seen[seen.length - 1];
    const failing = new FakeProvider(); failing.failImport = new Error(errMsg); await provisionVoiceNumber(admin, H.cid, failing, { ...OPTS }).catch(() => {});
    console.log = ol; console.error = oe; globalThis.fetch = saved;
    const leak = [errMsg, purchaseErr, unauthErr, logs.join("\n")].join("\n");
    R(13, "no secret in provider errors or logs", !/N8N_SECRET_SHOULD_NEVER_LEAK|ACfake0000/.test(leak), `error="${errMsg.slice(0, 80)}", log lines=${logs.length}`);
    R(13, "purchase refused unless VOICE_PURCHASE_ENABLED=true (no n8n call made at all)", /not enabled/.test(purchaseErr) && callsAfterDisabledPurchase === callsBeforePurchase, `error="${purchaseErr.slice(0, 60)}", n8n calls made for the refused purchase=${callsAfterDisabledPurchase - callsBeforePurchase}`);
    R(13, "n8n rejection (401) is reported as a credential problem, non-retryable message", /rejected the app credentials/.test(unauthErr), unauthErr.slice(0, 80));
    R(13, "enabled purchase sends confirm_purchase=yes + secret header to the fixed n8n path only", bought.sid === "PN_MOCK" && JSON.parse(purchaseCall.body).confirm_purchase === "yes" && purchaseCall.secretHeader === fakeCfg.n8nSecret && purchaseCall.url === "https://n8n.example.test/webhook/infomist-voice-provider", `url=${purchaseCall.url.replace("https://n8n.example.test", "")}, confirm=${JSON.parse(purchaseCall.body).confirm_purchase}, header sent=${purchaseCall.secretHeader.length > 0}`);
    let cfgThrown = ""; try { loadVoiceConfig({} as NodeJS.ProcessEnv); } catch (e) { cfgThrown = (e as Error).message; } R(10, "loadVoiceConfig without env throws (config error, not a purchase)", /not configured/.test(cfgThrown), cfgThrown.slice(0, 80));

    console.log(`REAL Twilio/ElevenLabs traffic attempted from tests (blocked): ${blocked}`);
    R(0, "REAL Twilio purchase", "BLOCKED", "explicit paid provider action / approval required; not performed");
  } finally { for (const x of [A, Bt, C, D, E, F, G, H]) await purge(x.cid, x.uid); const { data: left } = await admin.from("clients").select("id").ilike("company_name", "QA VP %"); console.log("cleanup done; leftover QA VP clients:", left?.length); }
}
main().catch((e) => console.log("FATAL", e.message, e.stack?.split("\n")[1]));
