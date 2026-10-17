import { mintSessionToken, voiceSecret } from "./session-token.ts";

/**
 * Pre-warm: while the owner's phone is still ringing, tell the voice bridge to fetch the session and open the
 * Gemini connection, so that on pickup it can speak at once. Best effort only: any failure just means the call
 * starts the normal (slower) way.
 */
export function prepareUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const stream = env.VOICE_STREAM_URL?.trim();
  if (!stream) return null;
  try {
    const u = new URL(stream);
    u.protocol = u.protocol === "ws:" ? "http:" : "https:";
    u.pathname = "/prepare";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

export async function requestBridgePrepare(
  clientId: string,
  reason = "daily_report",
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const url = prepareUrl(env);
  if (!url || !voiceSecret()) return false;
  try {
    const { exp, token } = mintSessionToken(clientId, reason);
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-voice-secret": voiceSecret() },
      body: JSON.stringify({ client_id: clientId, reason, exp, token }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
