import {
  VoiceProviderError,
  type TwilioNumber,
  type VoiceProvider,
  type VoiceConfig,
} from "@/lib/voice/provider";

/**
 * Direct Twilio provider.
 *
 * Why this exists: the app's original design routed every provider operation
 * through an n8n workflow that holds the credentials. That workflow is not
 * configured here (N8N_WEBHOOK_SECRET is empty), so buying a number and placing
 * calls were both dead. This talks to Twilio's REST API directly instead, using
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from the environment.
 *
 * It implements the SAME VoiceProvider interface, so it is a drop-in: the
 * provisioning state machine, its money-safety rules, and its tests are
 * unchanged, and the n8n provider is still used whenever it is configured.
 *
 * Two deliberate properties:
 *  - Purchasing and calling are still gated on VOICE_PURCHASE_ENABLED === "true".
 *    Holding credentials must never, by itself, let the app spend money.
 *  - Credentials are only ever sent as an Authorization header, and every error
 *    is scrubbed before it reaches a log or the UI.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** ISO country -> Twilio AvailablePhoneNumbers path segment (mostly the same). */
function countryPath(code: string): string {
  return (code || "US").trim().toUpperCase();
}

export function twilioConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID?.trim() && env.TWILIO_AUTH_TOKEN?.trim());
}

interface TwilioPhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  capabilities?: Record<string, boolean>;
}

interface TwilioAvailable {
  phone_number: string;
  capabilities?: Record<string, boolean>;
  locality?: string;
  region?: string;
}

export function createTwilioVoiceProvider(cfg: VoiceConfig, env: NodeJS.ProcessEnv = process.env): VoiceProvider {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) throw new VoiceProviderError("Twilio credentials are not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)", "config", false);

  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  // The dialled-call TwiML endpoint: our own voice app. Set on every number we
  // buy so calls are answered by us rather than falling through to nothing.
  const voiceUrl = `${(env.PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twiml`;

  function scrub(text: string): string {
    let t = String(text).slice(0, 300);
    t = t.split(token!).join("[redacted]");
    t = t.replace(/\b(AC|SK)[0-9a-fA-F]{28,}\b/g, "[redacted]");
    return t;
  }

  async function call<T>(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<T> {
    const method = init?.method ?? "GET";
    const body = init?.form ? new URLSearchParams(init.form) : undefined;
    let res: Response;
    try {
      res = await fetch(`${TWILIO_API}/Accounts/${sid}${path}`, {
        method,
        headers: {
          Authorization: auth,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new VoiceProviderError(`Twilio request failed: ${scrub((e as Error).message)}`, "twilio", true);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok) {
      const message = (json as { message?: string; code?: number } | null)?.message ?? text;
      if ((json as { code?: number } | null)?.code === 20003 && /not active/i.test(message)) {
        throw new VoiceProviderError(
          "Your Twilio account is suspended or closed, so no call can be placed or answered. Open console.twilio.com, fix the account status (balance / upgrade / verification), then try again.",
          "twilio",
          false
        );
      }
      throw new VoiceProviderError(
        `Twilio error (${res.status}): ${scrub(message)}`,
        "twilio",
        res.status >= 500 || res.status === 429
      );
    }
    return json as T;
  }

  return {
    async searchAvailableNumber(countryCode) {
      const cc = countryPath(countryCode);
      const data = await call<{ available_phone_numbers?: TwilioAvailable[] }>(
        `/AvailablePhoneNumbers/${cc}/Local.json?VoiceEnabled=true&PageSize=20`
      );
      const numbers = data.available_phone_numbers ?? [];
      // Prefer one that can actually do voice + sms; otherwise take the first.
      const best = numbers.find((n) => n.capabilities?.voice) ?? numbers[0];
      return best?.phone_number ?? null;
    },

    async findOwnedNumber(friendlyName) {
      const data = await call<{ incoming_phone_numbers?: TwilioPhoneNumber[] }>(
        `/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(friendlyName)}&PageSize=20`
      );
      const match = (data.incoming_phone_numbers ?? []).find((n) => n.friendly_name === friendlyName);
      return match ? { phoneNumber: match.phone_number, sid: match.sid } : null;
    },

    async purchaseNumber(phoneNumber, friendlyName) {
      if (!cfg.purchaseEnabled) {
        throw new VoiceProviderError("Number purchasing is not enabled (VOICE_PURCHASE_ENABLED is not 'true')", "config", false);
      }
      // Adopt instead of buying twice if this exact number is already ours —
      // Twilio would happily bill a second registration otherwise.
      const existing = await call<{ incoming_phone_numbers?: TwilioPhoneNumber[] }>(
        `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}&PageSize=5`
      );
      const owned = (existing.incoming_phone_numbers ?? []).find((n) => n.phone_number === phoneNumber);
      if (owned) return { phoneNumber: owned.phone_number, sid: owned.sid };

      const created = await call<TwilioPhoneNumber>(`/IncomingPhoneNumbers.json`, {
        method: "POST",
        form: {
          PhoneNumber: phoneNumber,
          FriendlyName: friendlyName,
          ...(voiceUrl.startsWith("http") ? { VoiceUrl: voiceUrl, VoiceMethod: "POST" } : {}),
        },
      });
      if (!created?.sid || !created?.phone_number) {
        throw new VoiceProviderError("Twilio did not return a purchased number", "twilio", false);
      }
      return { phoneNumber: created.phone_number, sid: created.sid };
    },

    /**
     * Point the number at our own voice app.
     *
     * The original flow imported the number into ElevenLabs and returned
     * ElevenLabs' phone_number_id. There is no ELEVENLABS_API_KEY in this
     * environment, so that is impossible — and rather than leave a freshly
     * bought number unanswered, this sets the Twilio VoiceUrl to our own TwiML
     * endpoint and returns a local marker. The number is immediately usable;
     * switching to ElevenLabs later is just setting the env key and re-running.
     */
    async importToElevenLabs(number, label) {
      if (!voiceUrl.startsWith("http")) {
        throw new VoiceProviderError("PUBLIC_APP_URL is not set, so the number cannot be pointed at our voice app", "config", false);
      }
      await call<TwilioPhoneNumber>(`/IncomingPhoneNumbers/${number.sid}.json`, {
        method: "POST",
        form: { VoiceUrl: voiceUrl, VoiceMethod: "POST", FriendlyName: label },
      });
      return `local:${number.sid}`;
    },

    async placeCall({ from, to, metadata }) {
      if (!cfg.purchaseEnabled) {
        throw new VoiceProviderError("Outbound calling is not enabled (VOICE_PURCHASE_ENABLED is not 'true')", "config", false);
      }
      if (!voiceUrl.startsWith("http")) {
        throw new VoiceProviderError("PUBLIC_APP_URL is not set, so the call has no voice app to reach", "config", false);
      }
      // The tenant is passed to our TwiML endpoint in the URL, not trusted from
      // the callee — the endpoint re-resolves it from the dialled number anyway.
      const url = new URL(voiceUrl);
      url.searchParams.set("reason", String(metadata.reason ?? "outbound"));
      url.searchParams.set("client_id", String(metadata.client_id ?? ""));
      const created = await call<{ sid?: string }>(`/Calls.json`, {
        method: "POST",
        form: { From: from, To: to, Url: url.toString(), Method: "POST" },
      });
      if (!created?.sid) throw new VoiceProviderError("Twilio did not return a call SID", "twilio", true);
      return { callSid: created.sid };
    },
  };
}
