import { test } from "node:test";
import assert from "node:assert/strict";
import { decideProvisioningGate } from "../src/lib/domain-provisioning-core.ts";

test("disconnected domain is blocked even when ownership is otherwise usable (regression: mailbox creation used to silently reconnect it)", () => {
  const result = decideProvisioningGate({ dnsStatus: "disconnected", usable: { usable: true } });
  assert.equal(result.proceed, false);
  if (result.proceed) throw new Error("expected blocked");
  assert.match(result.notes[0], /disconnected/i);
});

test("a domain owned by a different client is blocked regardless of dns_status", () => {
  const result = decideProvisioningGate({ dnsStatus: "pending", usable: { usable: false, reason: "owned_by_other" } });
  assert.equal(result.proceed, false);
  if (result.proceed) throw new Error("expected blocked");
  assert.match(result.notes[0], /different account/i);
});

test("an external domain with no completed ownership challenge is blocked", () => {
  const result = decideProvisioningGate({ dnsStatus: "pending", usable: { usable: false, reason: "ownership_not_verified" } });
  assert.equal(result.proceed, false);
  if (result.proceed) throw new Error("expected blocked");
  assert.match(result.notes[0], /DNS TXT challenge/i);
});

test("a usable, non-disconnected domain proceeds", () => {
  const result = decideProvisioningGate({ dnsStatus: "pending", usable: { usable: true } });
  assert.deepEqual(result, { proceed: true });
});

test("reconnect's own dns_status='pending' write happens BEFORE this gate runs, so a just-reconnected domain is never blocked by this check", () => {
  // Simulates the reconnect endpoint's sequence: it sets dns_status to
  // "pending" first, then calls ensureDomainProvisioned — by the time this
  // gate sees it, it is indistinguishable from any other pending domain.
  const result = decideProvisioningGate({ dnsStatus: "pending", usable: { usable: true } });
  assert.equal(result.proceed, true);
});

test("null/undefined dns_status (brand-new domain row) is never mistaken for disconnected", () => {
  assert.deepEqual(decideProvisioningGate({ dnsStatus: null, usable: { usable: true } }), { proceed: true });
  assert.deepEqual(decideProvisioningGate({ dnsStatus: undefined, usable: { usable: true } }), { proceed: true });
});
