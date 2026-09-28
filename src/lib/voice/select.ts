import { createN8nVoiceProvider, missingVoiceConfig, voicePurchaseEnabled, type VoiceConfig, type VoiceProvider } from "@/lib/voice/provider";
import { createTwilioVoiceProvider, twilioConfigured } from "@/lib/voice/twilio-direct";

/**
 * Which voice provider can actually do the work right now?
 *
 * Two are possible, and the app prefers the original one:
 *
 *  - "n8n": the designed path. Credentials live in the n8n workflow, and the
 *    app only holds a webhook URL and a secret. Requires N8N_BASE_URL,
 *    N8N_WEBHOOK_SECRET and ELEVENLABS_AGENT_ID.
 *  - "twilio-direct": talks to Twilio's REST API with TWILIO_ACCOUNT_SID /
 *    TWILIO_AUTH_TOKEN held in this app. Used when n8n is not fully configured,
 *    because otherwise buying a number and placing calls are simply dead.
 *
 * Selection is pure and side-effect free so callers can both decide and report
 * *why* nothing is available, and so it is obvious which path is in use.
 */
export type VoiceMode = "n8n" | "twilio-direct" | "none";

export interface VoiceReadiness {
  mode: VoiceMode;
  ready: boolean;
  purchaseEnabled: boolean;
  /** Variable names (never values) that are missing for the selected mode. */
  missing: string[];
}

function configFrom(env: NodeJS.ProcessEnv): VoiceConfig {
  return {
    n8nBaseUrl: (env.N8N_BASE_URL ?? "").trim().replace(/\/$/, ""),
    n8nSecret: (env.N8N_WEBHOOK_SECRET ?? "").trim(),
    elevenLabsAgentId: (env.ELEVENLABS_AGENT_ID ?? "").trim(),
    countryCode: (env.VOICE_COUNTRY_CODE || "US").trim().toUpperCase(),
    purchaseEnabled: voicePurchaseEnabled(env),
  };
}

export function voiceReadiness(env: NodeJS.ProcessEnv = process.env): VoiceReadiness {
  const purchaseEnabled = voicePurchaseEnabled(env);
  const n8nMissing = missingVoiceConfig(env);
  if (n8nMissing.length === 0) {
    return { mode: "n8n", ready: true, purchaseEnabled, missing: [] };
  }
  const twilioMissing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((k) => !env[k]?.trim());
  if (twilioMissing.length === 0) {
    return { mode: "twilio-direct", ready: true, purchaseEnabled, missing: [] };
  }
  // Report what the ORIGINAL path needs, since that is the one to finish if the
  // operator wants ElevenLabs; n8n being unset is the usual starting point.
  return { mode: "none", ready: false, purchaseEnabled, missing: n8nMissing.concat(twilioMissing) };
}

export function selectVoiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceProvider | null {
  const r = voiceReadiness(env);
  if (!r.ready) return null;
  const cfg = configFrom(env);
  return r.mode === "n8n" ? createN8nVoiceProvider(cfg) : createTwilioVoiceProvider(cfg, env);
}
