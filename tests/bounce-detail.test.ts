import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBounceDetail } from "../src/lib/bounce-detail.ts";

test("keeps severity, reason, the receiver's delivery-status and the event time", () => {
  const d = buildBounceDetail({
    severity: "permanent",
    reason: "bounce",
    timestamp: 1760875200,
    "delivery-status": { code: 550, message: "5.1.1 user unknown" },
  });
  assert.equal(d.severity, "permanent");
  assert.equal(d.reason, "bounce");
  assert.deepEqual(d.delivery_status, { code: 550, message: "5.1.1 user unknown" });
  assert.equal(d.event_at, "2025-10-19T12:00:00.000Z");
});

test("missing fields become null instead of throwing", () => {
  const d = buildBounceDetail({});
  assert.deepEqual(d, { severity: null, reason: null, delivery_status: null, event_at: null });
});

test("an oversized delivery-status is cut down but keeps code and a message prefix", () => {
  const d = buildBounceDetail({ "delivery-status": { code: 421, message: "x".repeat(10000) } });
  const ds = d.delivery_status as { truncated: boolean; code: number; message: string };
  assert.equal(ds.truncated, true);
  assert.equal(ds.code, 421);
  assert.equal(ds.message.length, 500);
});
