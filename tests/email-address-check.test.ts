import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEmailAddress, type MxResolver } from "../src/lib/email-address-check.ts";

const nx = () => Object.assign(new Error("nx"), { code: "ENOTFOUND" });
const resolver = (o: { mx?: string[]; a?: string[]; fail?: string }): MxResolver => ({
  resolveMx: async () => (o.fail ? Promise.reject(Object.assign(new Error("f"), { code: o.fail })) : o.mx ? o.mx.map((exchange) => ({ exchange, priority: 10 })) : Promise.reject(nx())),
  resolve4: async () => (o.a ? o.a : Promise.reject(nx())),
  resolve6: async () => Promise.reject(nx()),
});

test("bad syntax and disposable domains are rejected", async () => {
  assert.deepEqual(await checkEmailAddress("not-an-email", resolver({ mx: ["m.x.com"] })), { ok: false, reason: "syntax" });
  assert.deepEqual(await checkEmailAddress("a@mailinator.com", resolver({ mx: ["m"] })), { ok: false, reason: "disposable" });
});

test("domain with an MX record passes", async () => {
  assert.deepEqual(await checkEmailAddress("a@acme.com", resolver({ mx: ["mx.acme.com"] })), { ok: true });
});

test("no MX but an A record passes (implicit MX)", async () => {
  assert.deepEqual(await checkEmailAddress("a@acme.com", resolver({ a: ["1.2.3.4"] })), { ok: true });
});

test("domain that does not exist is rejected", async () => {
  assert.deepEqual(await checkEmailAddress("a@nope-acme.com", resolver({})), { ok: false, reason: "no_mail_server" });
});

test("a failed lookup (timeout) never blocks a send", async () => {
  assert.deepEqual(await checkEmailAddress("a@acme.com", resolver({ fail: "ETIMEOUT" })), { ok: true });
});

test("reserved test TLDs skip the lookup", async () => {
  assert.deepEqual(await checkEmailAddress("a@prospect.test", resolver({})), { ok: true });
});
