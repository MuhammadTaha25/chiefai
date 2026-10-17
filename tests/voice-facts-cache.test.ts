import test from "node:test";
import assert from "node:assert/strict";
import { getCompanyFactsCached } from "../src/lib/company-facts.ts";

// A fake admin whose every query resolves to an empty result; counts how many queries it was asked.
function fakeAdmin(counter: { n: number }) {
  const q: Record<string, unknown> = {};
  const chain = new Proxy(q, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => { counter.n++; res({ data: [], count: 0, error: null }); };
      return () => chain;
    },
  });
  return { from: () => chain } as never;
}

test("facts are computed once within the cache window and again after it", async () => {
  const c = { n: 0 };
  const admin = fakeAdmin(c);
  const t0 = 1_000_000_000_000;
  await getCompanyFactsCached(admin, "client-cache-a", "UTC", t0);
  const after1 = c.n;
  assert.ok(after1 > 0);
  await getCompanyFactsCached(admin, "client-cache-a", "UTC", t0 + 60_000);
  assert.equal(c.n, after1, "served from cache inside 2 minutes");
  await getCompanyFactsCached(admin, "client-cache-a", "UTC", t0 + 130_000);
  assert.ok(c.n > after1, "recomputed after the window");
});

test("different clients do not share cached facts", async () => {
  const c = { n: 0 };
  const admin = fakeAdmin(c);
  const t0 = 2_000_000_000_000;
  await getCompanyFactsCached(admin, "client-cache-b", "UTC", t0);
  const n1 = c.n;
  await getCompanyFactsCached(admin, "client-cache-c", "UTC", t0);
  assert.ok(c.n > n1);
});
