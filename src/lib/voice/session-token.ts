import crypto from "node:crypto";

/**
 * Short-lived proof that a live-audio session was authorised by our own TwiML
 * endpoint (which has already verified Twilio's signature and resolved the
 * tenant). The bridge carries it back to /api/voice/live, so nobody who merely
 * reaches the WebSocket can ask for a tenant's data by naming a client id.
 */
export const voiceSecret = () => process.env.VOICE_FACTS_SECRET ?? process.env.N8N_WEBHOOK_SECRET ?? "";

const TTL_MS = 10 * 60 * 1000;

const sign = (payload: string) => crypto.createHmac("sha256", voiceSecret()).update(payload).digest("hex");

export function mintSessionToken(clientId: string, reason: string): { exp: number; token: string } {
  const exp = Date.now() + TTL_MS;
  return { exp, token: sign(`${clientId}.${reason}.${exp}`) };
}

export function verifySessionToken(clientId: string, reason: string, exp: number, token: string): boolean {
  if (!voiceSecret() || !token || !Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(`${clientId}.${reason}.${exp}`);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}
