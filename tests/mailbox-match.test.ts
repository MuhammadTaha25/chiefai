import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMailboxMatch } from "../src/lib/mailbox-match.ts";

test("no rows classifies as 'none'", () => {
  assert.deepEqual(classifyMailboxMatch([]), { kind: "none" });
});

test("exactly one row classifies as 'single' and carries the row through", () => {
  const row = { id: "m1", client_id: "c1", address: "sales@a.com" };
  assert.deepEqual(classifyMailboxMatch([row]), { kind: "single", row });
});

test("two or more rows classify as 'ambiguous', never silently collapsed to 'none' or 'single' (the actual P0/regression bug: .maybeSingle() used to error on this and fall through as 'not found')", () => {
  const rowA = { id: "m1", client_id: "client-a", address: "sales@victim.com" };
  const rowB = { id: "m2", client_id: "client-b", address: "sales@victim.com" };
  const result = classifyMailboxMatch([rowA, rowB]);
  assert.equal(result.kind, "ambiguous");
  if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
  assert.deepEqual(result.rows, [rowA, rowB]);
});
