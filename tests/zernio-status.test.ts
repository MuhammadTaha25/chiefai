import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ZERNIO_BASE_URL = "https://zernio.test/v1";
process.env.ZERNIO_API_KEY_GOOGLE_META = "test-key";
process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM = "test-key";

type Call = { method: string; url: string };

function stubFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: String(url).replace("https://zernio.test/v1", "") };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("publish repairs Zernio's ad record first and succeeds when it works", async () => {
  const { setCampaignStatusResilient } = await import("../src/lib/zernio.ts");
  const calls = stubFetch((c) => (c.url.startsWith("/ads/campaigns/") ? { status: 200, body: { status: "active" } } : { status: 200, body: { ad: {} } }));
  const r = await setCampaignStatusResilient("google_meta", { campaignId: "C1", metaAdId: "AD1", status: "active", platform: "facebook" });
  assert.equal(r.status, "active");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET /ads/AD1", "PUT /ads/campaigns/C1/status"]);
});

test("a 404 'Campaign not found' is retried once after re-importing the ad", async () => {
  const { setCampaignStatusResilient } = await import("../src/lib/zernio.ts");
  let puts = 0;
  const calls = stubFetch((c) => {
    if (c.method === "PUT") return ++puts === 1 ? { status: 404, body: { error: "Campaign not found" } } : { status: 200, body: { status: "active" } };
    return { status: 200, body: { ad: {} } };
  });
  const r = await setCampaignStatusResilient("google_meta", { campaignId: "C1", metaAdId: "AD1", status: "active", platform: "facebook" });
  assert.equal(r.status, "active");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 2);
});

test("a genuine failure is not swallowed, and a non-404 is not retried", async () => {
  const { setCampaignStatusResilient } = await import("../src/lib/zernio.ts");
  const calls = stubFetch((c) => (c.method === "PUT" ? { status: 500, body: { error: "boom" } } : { status: 200, body: {} }));
  await assert.rejects(() => setCampaignStatusResilient("google_meta", { campaignId: "C1", metaAdId: "AD1", status: "active", platform: "facebook" }), /500/);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
});
