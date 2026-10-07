import test from "node:test";
import assert from "node:assert/strict";
import { formatInTimezone } from "../src/lib/format-time.ts";
import { liveStreamReachable } from "../src/lib/voice/stream-availability.ts";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

test("formatInTimezone shows Pakistan time for a UTC timestamp (the TC-08 case)", () => {
  // 11:58 UTC is 4:58 PM in Karachi (UTC+5, no DST).
  assert.equal(formatInTimezone("2026-10-07T11:58:00Z", "Asia/Karachi"), "Oct 7, 2026, 4:58 PM");
});

test("formatInTimezone rolls the date over when the offset crosses midnight", () => {
  assert.equal(formatInTimezone("2026-10-07T20:30:00Z", "Asia/Karachi"), "Oct 8, 2026, 1:30 AM");
});

test("formatInTimezone honours another timezone", () => {
  assert.equal(formatInTimezone("2026-10-07T11:58:00Z", "UTC"), "Oct 7, 2026, 11:58 AM");
});

test("formatInTimezone falls back instead of throwing on an unknown timezone", () => {
  assert.equal(formatInTimezone("2026-10-07T11:58:00Z", "Not/AZone"), "Oct 7, 2026, 4:58 PM");
});

test("formatInTimezone returns a dash for missing or invalid dates", () => {
  assert.equal(formatInTimezone(null, "Asia/Karachi"), "—");
  assert.equal(formatInTimezone("", "Asia/Karachi"), "—");
  assert.equal(formatInTimezone("not a date", "Asia/Karachi"), "—");
});

test("live stream is assumed reachable when not on Vercel (bridge runs inside the app)", () => {
  assert.equal(liveStreamReachable(env({})), true);
  assert.equal(liveStreamReachable(env({ VOICE_STREAM_URL: "wss://x/stream" })), true);
});

test("on Vercel the live stream is only reachable through an external VOICE_STREAM_URL", () => {
  assert.equal(liveStreamReachable(env({ VERCEL: "1" })), false);
  assert.equal(liveStreamReachable(env({ VERCEL: "1", VOICE_STREAM_URL: "   " })), false);
  assert.equal(liveStreamReachable(env({ VERCEL: "1", VOICE_STREAM_URL: "wss://bridge.example.com/stream" })), true);
});
