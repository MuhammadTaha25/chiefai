import test from "node:test";
import assert from "node:assert/strict";
import { frames, loadGreeting } from "../src/lib/voice/bridge.ts";

test("greeting is cut into 20 ms frames and nothing is lost", () => {
  const f = frames(Buffer.alloc(1000, 7));
  assert.equal(f.length, 7);
  assert.equal(f.reduce((n, b) => n + b.length, 0), 1000);
  assert.equal(f[0].length, 160);
});

test("a missing greeting file simply means no greeting", () => {
  assert.equal(loadGreeting("/nonexistent/voice-greeting.mulaw"), null);
});
