import crypto from "crypto";

/**
 * Signed, expiring OAuth `state`. The callback routes are public URLs that
 * attribute a connection to whatever client_id the state names — with an
 * unsigned state, anyone could craft a callback (their own provider `code` +
 * a victim's client_id) and overwrite the victim's Calendly/social
 * connection. Signing with a server-only secret means only a state minted by
 * the authenticated /connect route for that user is ever accepted.
 */
function secret(): string {
  const s = process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("OAUTH_STATE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be configured");
  // Derive so the raw service key is never used directly as an HMAC key.
  return crypto.createHash("sha256").update("oauth-state:" + s).digest("hex");
}

const TTL_MS = 15 * 60 * 1000;

export function signOAuthState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyOAuthState<T extends Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Only same-site relative paths: rejects "//evil.com", "/\evil.com" and absolute URLs. */
export function safeReturnPath(next: unknown, fallback = "/settings"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
