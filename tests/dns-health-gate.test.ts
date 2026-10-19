import { test } from "node:test";
import assert from "node:assert/strict";
import { getSendingBrokenDomains } from "../src/lib/dns-health-gate.ts";

const admin = (rows: unknown[]) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ returns: async () => ({ data: rows }) }) }) }) }) as never;
const rows = [
  { domain: "Bad.com", dns_health: { sendingOk: false } },
  { domain: "good.com", dns_health: { sendingOk: true } },
  { domain: "new.com", dns_health: null },
];

test("pause is OFF by default: nothing is ever blocked", async () => {
  delete process.env.DNS_HEALTH_PAUSE_SENDING;
  assert.equal((await getSendingBrokenDomains(admin(rows), "c")).size, 0);
});

test("with the flag on, only domains whose SPF/DKIM check failed are blocked", async () => {
  process.env.DNS_HEALTH_PAUSE_SENDING = "1";
  const set = await getSendingBrokenDomains(admin(rows), "c");
  delete process.env.DNS_HEALTH_PAUSE_SENDING;
  assert.deepEqual([...set], ["bad.com"]);
});
