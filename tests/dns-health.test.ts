import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDomainDns, type DnsResolver, type ExpectedRecords } from "../src/lib/dns-health-core.ts";

const expected: ExpectedRecords = {
  sending: [
    { record_type: "TXT", name: "acme.com", value: "v=spf1 include:mailgun.org ~all" },
    { record_type: "TXT", name: "krs._domainkey.acme.com", value: "k=rsa; p=MIGfABC123" },
    { record_type: "CNAME", name: "email.acme.com", value: "mailgun.org" },
  ],
  receiving: [{ record_type: "MX", value: "mxa.mailgun.org", priority: "10" }, { record_type: "MX", value: "mxb.mailgun.org", priority: "10" }],
};

const resolver = (txt: Record<string, string[][]>, mx: string[] = ["mxa.mailgun.org.", "mxb.mailgun.org."], cname: Record<string, string[]> = { "email.acme.com": ["mailgun.org."] }): DnsResolver => ({
  resolveTxt: async (n) => txt[n] ?? Promise.reject(Object.assign(new Error("n"), { code: "ENODATA" })),
  resolveMx: async () => mx.map((exchange) => ({ exchange, priority: 10 })),
  resolveCname: async (n) => cname[n] ?? Promise.reject(Object.assign(new Error("n"), { code: "ENODATA" })),
});

const good = {
  "acme.com": [["v=spf1 include:mailgun.org ~all"]],
  "krs._domainkey.acme.com": [["k=rsa; p=MIGf", "ABC123"]],
  "_dmarc.acme.com": [["v=DMARC1; p=none"]],
};
const kind = (h: Awaited<ReturnType<typeof checkDomainDns>>, k: string) => h.checks.find((c) => c.kind === k)!;

test("everything published correctly", async () => {
  const h = await checkDomainDns("acme.com", expected, resolver(good));
  assert.equal(h.allOk, true);
  assert.equal(h.sendingOk, true);
});

test("missing DMARC does not block sending but is reported", async () => {
  const { ["_dmarc.acme.com"]: _d, ...noDmarc } = good;
  const h = await checkDomainDns("acme.com", expected, resolver(noDmarc));
  assert.equal(kind(h, "dmarc").status, "missing");
  assert.equal(h.sendingOk, true);
  assert.equal(h.allOk, false);
});

test("two SPF records is flagged", async () => {
  const h = await checkDomainDns("acme.com", expected, resolver({ ...good, "acme.com": [["v=spf1 include:mailgun.org ~all"], ["v=spf1 include:_spf.google.com ~all"]] }));
  assert.equal(kind(h, "spf").status, "duplicate_spf");
  assert.equal(h.sendingOk, false);
});

test("SPF without mailgun include is a mismatch", async () => {
  const h = await checkDomainDns("acme.com", expected, resolver({ ...good, "acme.com": [["v=spf1 include:_spf.google.com ~all"]] }));
  assert.equal(kind(h, "spf").status, "mismatch");
});

test("SPF may carry extra includes", async () => {
  const h = await checkDomainDns("acme.com", expected, resolver({ ...good, "acme.com": [["v=spf1 include:_spf.google.com include:mailgun.org ~all"]] }));
  assert.equal(kind(h, "spf").status, "ok");
});

test("wrong DKIM key is a mismatch, absent is missing", async () => {
  const wrong = await checkDomainDns("acme.com", expected, resolver({ ...good, "krs._domainkey.acme.com": [["k=rsa; p=OTHER"]] }));
  assert.equal(kind(wrong, "dkim").status, "mismatch");
  const { ["krs._domainkey.acme.com"]: _k, ...noDkim } = good;
  const miss = await checkDomainDns("acme.com", expected, resolver(noDkim));
  assert.equal(kind(miss, "dkim").status, "missing");
  assert.equal(miss.sendingOk, false);
});

test("MX and CNAME problems are reported without blocking sending", async () => {
  const h = await checkDomainDns("acme.com", expected, resolver(good, ["mx.other.com"], {}));
  assert.equal(kind(h, "mx").status, "mismatch");
  assert.equal(kind(h, "cname").status, "missing");
  assert.equal(h.sendingOk, true);
});

test("a lookup failure (timeout) is not reported as 'missing': it throws so the old result is kept", async () => {
  const flaky: DnsResolver = {
    resolveTxt: async () => Promise.reject(Object.assign(new Error("t"), { code: "ETIMEOUT" })),
    resolveMx: async () => [],
    resolveCname: async () => [],
  };
  await assert.rejects(() => checkDomainDns("acme.com", expected, flaky));
});

import { isMailgunDomainNotFound, notInMailgunHealth } from "../src/lib/dns-health-core.ts";

test("Mailgun 404 is recognised and reported as a clear, sending-blocking problem", () => {
  assert.equal(isMailgunDomainNotFound(new Error('Mailgun get domain failed: 404 {"message":"Domain not found"}')), true);
  assert.equal(isMailgunDomainNotFound(new Error("Mailgun get domain failed: 500 oops")), false);
  const h = notInMailgunHealth("x.com");
  assert.equal(h.problem, "not_in_mailgun");
  assert.equal(h.sendingOk, false);
});
