import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateMailboxes, inboundRouteStatus } from "../src/lib/platform-health-core.ts";

const URL_OK = "https://infomistqa4827.online/api/webhooks/mailgun";

test("the same mailbox address on two clients is reported (the 20 Oct outage)", () => {
  const d = findDuplicateMailboxes([
    { address: "sales@techyworld.site", client_id: "a" },
    { address: "Sales@Techyworld.site ", client_id: "b" },
    { address: "hello@techyworld.site", client_id: "a" },
  ]);
  assert.deepEqual(d, [{ address: "sales@techyworld.site", clients: 2, rows: 2 }]);
});

test("unique mailbox addresses report nothing", () => {
  assert.deepEqual(findDuplicateMailboxes([{ address: "a@x.com", client_id: "1" }, { address: "b@x.com", client_id: "1" }]), []);
});

test("catch-all pointing at a dead tunnel is flagged (the 20 Oct outage)", () => {
  const r = inboundRouteStatus([{ expression: "catch_all()", actions: ['forward("https://old.ngrok-free.dev/api/webhooks/mailgun")', "stop()"] }], URL_OK);
  assert.deepEqual(r, { ok: false, problem: "wrong_url", catchAlls: 1 });
});

test("no catch-all route at all is flagged", () => {
  assert.deepEqual(inboundRouteStatus([{ expression: 'match_recipient("a@b.c")', actions: ["stop()"] }], URL_OK), { ok: false, problem: "no_catch_all", catchAlls: 0 });
});

test("a correct catch-all passes, and stale extra catch-alls are counted", () => {
  const good = { expression: "catch_all()", actions: [`forward("${URL_OK}")`, "stop()"] };
  assert.deepEqual(inboundRouteStatus([good], URL_OK), { ok: true, staleCatchAlls: 0 });
  const stale = { expression: "catch_all()", actions: ['forward("https://old.example/x")'] };
  assert.deepEqual(inboundRouteStatus([good, stale], URL_OK), { ok: true, staleCatchAlls: 1 });
});

import { buildPlatformAlert } from "../src/lib/platform-alert-core.ts";

test("alert: nothing wrong -> no mail", () => {
  assert.equal(buildPlatformAlert({ sendingBroken: 0, errors: 0, platform: { duplicateMailboxes: [], inboundRoute: { ok: true }, needsAttention: false } }), null);
  assert.equal(buildPlatformAlert({ sendingBroken: 0, errors: 0 }), null);
});

test("alert: broken DNS, duplicate mailbox and bad inbound route each appear", () => {
  const a = buildPlatformAlert({
    sendingBroken: 1,
    errors: 0,
    platform: { duplicateMailboxes: [{ address: "sales@x.com", clients: 2, rows: 2 }], inboundRoute: { ok: false, problem: "wrong_url" }, needsAttention: true },
  });
  assert.ok(a);
  assert.match(a.text, /cannot send/);
  assert.match(a.text, /sales@x\.com/);
  assert.match(a.text, /wrong_url/);
});
