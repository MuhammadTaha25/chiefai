import test from "node:test";
import assert from "node:assert/strict";
import { prepareUrl, requestBridgePrepare } from "../src/lib/voice/prepare.ts";

test("prepare URL is derived from the stream URL", () => {
  assert.equal(prepareUrl({ VOICE_STREAM_URL: "wss://abc.trycloudflare.com/stream" } as unknown as NodeJS.ProcessEnv), "https://abc.trycloudflare.com/prepare");
  assert.equal(prepareUrl({} as unknown as NodeJS.ProcessEnv), null);
});

test("pre-warm never throws and reports failure", async () => {
  process.env.VOICE_FACTS_SECRET = "x";
  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal(await requestBridgePrepare("c1", "daily_report", { VOICE_STREAM_URL: "wss://h/stream" } as unknown as NodeJS.ProcessEnv, failing), false);
  let seen = "";
  const ok = (async (u: string) => { seen = u; return { ok: true }; }) as unknown as typeof fetch;
  assert.equal(await requestBridgePrepare("c1", "daily_report", { VOICE_STREAM_URL: "wss://h/stream" } as unknown as NodeJS.ProcessEnv, ok), true);
  assert.equal(seen, "https://h/prepare");
});
