// Standalone Gemini live voice bridge: runs ONLY the bridge, not the whole Next app.
//
//   node --import ./scripts/register-alias.mjs scripts/voice-bridge.ts
//
// Needs (environment):  GEMINI_API_KEY, VOICE_FACTS_SECRET (same value as the app),
//                       VOICE_APP_INTERNAL_URL (the deployed app, e.g. https://your-app.vercel.app)
// Optional:             VOICE_BRIDGE_PORT (8787), VOICE_BRIDGE_HOST (0.0.0.0 here), VOICE_GEMINI_VOICE, VOICE_SILENCE_MS
// See scripts/VOICE_BRIDGE_LOCAL.md for the tunnel and Vercel steps.
import { startVoiceBridge, bridgeConfigured, bridgePort } from "../src/lib/voice/bridge.ts";

process.env.VOICE_BRIDGE_HOST ||= "0.0.0.0";
if (!process.env.VOICE_APP_INTERNAL_URL) {
  console.error("VOICE_APP_INTERNAL_URL is required (the deployed app's https URL).");
  process.exit(1);
}
if (!bridgeConfigured()) {
  console.error("Bridge not configured: set GEMINI_API_KEY and VOICE_FACTS_SECRET.");
  process.exit(1);
}
if (!startVoiceBridge()) {
  console.error("Bridge did not start (is VERCEL set in this environment?).");
  process.exit(1);
}
console.log(`[voice] standalone bridge up on port ${bridgePort()}, path /stream`);
