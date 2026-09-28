/**
 * Voice provider layer. Server-only.
 *
 * The Twilio and ElevenLabs credentials live in n8n, so the app never holds them:
 * it calls ONE authenticated n8n webhook ("Infomist - Voice Provider (App-Called)")
 * that performs a single provider operation per call (search / find_owned /
 * purchase / import_elevenlabs). All orchestration - tenant identity, the durable
 * claim, idempotency, partial-state recovery and persistence - stays in the app
 * (see provision.ts); n8n is only the credential-holding executor.
 *
 * Everything money-relevant goes through the `VoiceProvider` interface so the state
 * machine is tested with a deterministic fake. The n8n implementation below is the
 * ONLY code that can trigger a purchase, and it refuses unless purchasing has been
 * explicitly enabled (VOICE_PURCHASE_ENABLED=true). n8n independently refuses a real
 * purchase without `confirm_purchase: "yes"`.
 */

export interface TwilioNumber {
  phoneNumber: string; // E.164
  sid: string;
}

export interface VoiceProvider {
  /** Reads Twilio (via n8n): first voice-enabled local number available to buy (no charge). */
  searchAvailableNumber(countryCode: string): Promise<string | null>;
  /** Reads Twilio (via n8n): a number this account already owns with this exact FriendlyName (no charge). */
  findOwnedNumber(friendlyName: string): Promise<TwilioNumber | null>;
  /** SPENDS MONEY. Buys the number. */
  purchaseNumber(phoneNumber: string, friendlyName: string): Promise<TwilioNumber>;
  /** ElevenLabs (via n8n): imports the Twilio number and assigns the agent; returns ElevenLabs' phone_number_id. */
  importToElevenLabs(number: TwilioNumber, label: string, agentId: string): Promise<string>;
  /**
   * SPENDS MONEY (per-minute). Places an OUTBOUND call from one of our numbers
   * to the client's own phone. `metadata` is echoed back on the call webhook so
   * the resulting row can be attributed to the right tenant and reason.
   */
  placeCall(params: { from: string; to: string; metadata: Record<string, string> }): Promise<{ callSid: string }>;
}

export class VoiceProviderError extends Error {
  constructor(message: string, public readonly kind: "twilio" | "elevenlabs" | "n8n" | "config", public readonly retryable = true) {
    super(message);
  }
}

export interface VoiceConfig {
  n8nBaseUrl: string;
  n8nSecret: string;
  elevenLabsAgentId: string;
  countryCode: string;
  purchaseEnabled: boolean;
}

const WEBHOOK_PATH = "/webhook/infomist-voice-provider";

/** Names of missing environment variables (never values). Empty array = configured. */
export function missingVoiceConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["N8N_BASE_URL", "N8N_WEBHOOK_SECRET", "ELEVENLABS_AGENT_ID"].filter((k) => !env[k]?.trim());
}

/** Purchasing is a deliberate, separate switch: configuring the connection alone never lets the app spend. */
export function voicePurchaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_PURCHASE_ENABLED === "true";
}

export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const missing = missingVoiceConfig(env);
  if (missing.length) throw new VoiceProviderError(`Voice provider is not configured (${missing.join(", ")})`, "config", false);
  return {
    n8nBaseUrl: env.N8N_BASE_URL!.trim().replace(/\/$/, ""),
    n8nSecret: env.N8N_WEBHOOK_SECRET!.trim(),
    elevenLabsAgentId: env.ELEVENLABS_AGENT_ID!.trim(),
    countryCode: (env.VOICE_COUNTRY_CODE || "US").trim().toUpperCase(),
    purchaseEnabled: voicePurchaseEnabled(env),
  };
}

const TIMEOUT_MS = 30_000;

/** Provider errors reach logs/UI, so strip anything credential-shaped first. */
function safeMessage(text: string, cfg: VoiceConfig): string {
  let t = String(text).slice(0, 300);
  for (const secret of [cfg.n8nSecret]) if (secret) t = t.split(secret).join("[redacted]");
  // Twilio account / API-key SIDs (AC..., SK...): be liberal about the alphabet, not just hex.
  return t.replace(/\b(AC|SK)[0-9A-Za-z]{28,}\b/g, "[redacted]");
}

interface N8nReply {
  ok?: boolean;
  error?: string;
  provider?: string;
  status?: number;
  [k: string]: unknown;
}

async function callN8n(cfg: VoiceConfig, body: Record<string, unknown>): Promise<N8nReply> {
  let res: Response;
  try {
    res = await fetch(`${cfg.n8nBaseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": cfg.n8nSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Timeout/network AFTER the request may have been accepted: the caller must treat the outcome as unknown.
    throw new VoiceProviderError(`n8n request failed: ${safeMessage((e as Error).message, cfg)}`, "n8n", true);
  }
  const text = await res.text().catch(() => "");
  let json: N8nReply = {};
  try {
    json = text ? (JSON.parse(text) as N8nReply) : {};
  } catch {
    /* handled below */
  }
  if (res.status === 401 || res.status === 403) throw new VoiceProviderError("n8n rejected the app credentials (check the webhook secret)", "n8n", false);
  if (res.status === 404) throw new VoiceProviderError("The n8n voice workflow is not active or the URL is wrong", "n8n", false);
  if (!res.ok || json.ok === false) {
    const kind = json.provider === "twilio" || json.provider === "elevenlabs" ? json.provider : "n8n";
    throw new VoiceProviderError(`${kind} error via n8n (${res.status}): ${safeMessage(json.error ?? text, cfg)}`, kind, res.status >= 500 || res.status === 429);
  }
  return json;
}

export function createN8nVoiceProvider(cfg: VoiceConfig): VoiceProvider {
  return {
    async searchAvailableNumber(countryCode) {
      const r = await callN8n(cfg, { action: "search", country_code: countryCode });
      return typeof r.phone_number === "string" ? r.phone_number : null;
    },

    async findOwnedNumber(friendlyName) {
      const r = await callN8n(cfg, { action: "find_owned", friendly_name: friendlyName });
      return r.found === true && typeof r.phone_number === "string" && typeof r.sid === "string" ? { phoneNumber: r.phone_number, sid: r.sid } : null;
    },

    async purchaseNumber(phoneNumber, friendlyName) {
      if (!cfg.purchaseEnabled) throw new VoiceProviderError("Number purchasing is not enabled (VOICE_PURCHASE_ENABLED is not 'true')", "config", false);
      const r = await callN8n(cfg, { action: "purchase", phone_number: phoneNumber, friendly_name: friendlyName, confirm_purchase: "yes" });
      if (typeof r.phone_number !== "string" || typeof r.sid !== "string" || r.dry_run === true) throw new VoiceProviderError("n8n did not return a purchased number", "twilio", false);
      return { phoneNumber: r.phone_number, sid: r.sid };
    },

    async importToElevenLabs(number, label, agentId) {
      const r = await callN8n(cfg, { action: "import_elevenlabs", phone_number: number.phoneNumber, agent_id: agentId, label });
      if (typeof r.phone_number_id !== "string" || !r.phone_number_id || r.dry_run === true) throw new VoiceProviderError("n8n did not return an ElevenLabs phone_number_id", "elevenlabs", true);
      return r.phone_number_id;
    },

    async placeCall({ from, to, metadata }) {
      // Same explicit switch as purchasing: configuring the connection must
      // never, on its own, let the app start spending money on phone calls.
      if (!cfg.purchaseEnabled) {
        throw new VoiceProviderError("Outbound calling is not enabled (VOICE_PURCHASE_ENABLED is not 'true')", "config", false);
      }
      const r = await callN8n(cfg, { action: "place_call", from, to, agent_id: cfg.elevenLabsAgentId, metadata, confirm_purchase: "yes" });
      if (typeof r.call_sid !== "string" || !r.call_sid || r.dry_run === true) {
        throw new VoiceProviderError("n8n did not return a call SID for the outbound call", "twilio", true);
      }
      return { callSid: r.call_sid };
    },
  };
}
