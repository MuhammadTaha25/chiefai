import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionDomain, dnsStatusFor, type ProvisionDeps } from "../src/lib/provision-core.ts";

function deps(over: Partial<ProvisionDeps> = {}, calls: string[] = []): ProvisionDeps {
  const rec = <T,>(name: string, v: T) => async () => {
    calls.push(name);
    return v;
  };
  return {
    createMailgunDomain: rec("create", {}),
    getMailgunDnsRecords: rec("records", { sending: [], receiving: [] }),
    writeDns: rec("dns", { allConfirmed: true, failures: [] as string[] }),
    verifyMailgunDomain: rec("verify", "active" as string | null),
    createInboundRoute: rec("route", {}),
    registerTrackingWebhooks: rec("hooks", {}),
    sleep: async () => {},
    ...over,
  };
}

test("happy path runs every step in order and ends active", async () => {
  const calls: string[] = [];
  const r = await provisionDomain(deps({}, calls), { domain: "a.com", publicOrigin: "https://app" });
  assert.deepEqual(calls, ["create", "records", "dns", "verify", "route", "hooks"]);
  assert.equal(r.state, "active");
  assert.equal(dnsStatusFor(r.state), "active");
});

test("unconfirmed DNS stops before verification and is reported failed", async () => {
  const calls: string[] = [];
  const r = await provisionDomain(
    deps({ writeDns: async () => { calls.push("dns"); return { allConfirmed: false, failures: ["TXT @"] }; }, verifyMailgunDomain: async () => { calls.push("verify"); return "active"; } }, calls),
    { domain: "a.com", publicOrigin: "https://app" }
  );
  assert.equal(r.state, "dns_failed");
  assert.ok(!calls.includes("verify"), "must not verify against DNS the registrar did not confirm");
  assert.deepEqual(r.notes, ["DNS not confirmed: TXT @"]);
  assert.equal(dnsStatusFor(r.state), "provisioning_failed");
});

test("verification retries, and stays pending (never active) when Mailgun does not confirm", async () => {
  let n = 0;
  const r = await provisionDomain(deps({ verifyMailgunDomain: async () => { n++; return "unverified"; } }), { domain: "a.com", publicOrigin: "https://app", verifyAttempts: 3 });
  assert.equal(n, 3);
  assert.equal(r.state, "pending");
  assert.equal(dnsStatusFor(r.state), "pending");
});

test("route/webhook failures are recorded but do not fail provisioning; both URLs use the public origin", async () => {
  const urls: string[] = [];
  const r = await provisionDomain(
    deps({
      createInboundRoute: async (u) => { urls.push(u); throw new Error("Routes quota exceeded"); },
      registerTrackingWebhooks: async (_d, u) => { urls.push(u); throw new Error("webhook boom"); },
    }),
    { domain: "a.com", publicOrigin: "https://app.example" }
  );
  assert.equal(r.state, "active");
  assert.equal(r.notes.length, 2);
  assert.deepEqual(urls, ["https://app.example/api/webhooks/mailgun", "https://app.example/api/webhooks/mailgun/events"]);
});

test("a provider exception becomes an error state, not a crash or a false success", async () => {
  const r = await provisionDomain(deps({ createMailgunDomain: async () => { throw new Error("Mailgun domain create failed: 401"); } }), { domain: "a.com", publicOrigin: "https://app" });
  assert.equal(r.state, "error");
  assert.equal(dnsStatusFor(r.state), "provisioning_failed");
});

test("DMARC is attempted after DNS is confirmed; a failure is noted but never fails provisioning", async () => {
  const calls: string[] = [];
  const ok = await provisionDomain(deps({ ensureDmarc: async () => { calls.push("dmarc"); return "added"; } }, calls), { domain: "a.com", publicOrigin: "https://app" });
  assert.ok(calls.indexOf("dmarc") > calls.indexOf("dns"), "DMARC only after the registrar confirmed the other records");
  assert.equal(ok.state, "active");

  const bad = await provisionDomain(deps({ ensureDmarc: async () => { throw new Error("zone busy"); } }), { domain: "a.com", publicOrigin: "https://app" });
  assert.equal(bad.state, "active");
  assert.ok(bad.notes.some((n) => n.startsWith("dmarc")));
});
