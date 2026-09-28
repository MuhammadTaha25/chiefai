import crypto from "crypto";

/**
 * Webhook authentication helpers. Every inbound webhook is an unauthenticated
 * public URL, so authentication has to be fail-CLOSED: a missing secret or a
 * missing/invalid signature rejects the request. The one escape hatch is an
 * explicit dev flag, and it is ignored in production builds.
 */
export function unsignedWebhooksAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_UNSIGNED_WEBHOOKS === "true";
}

const MAX_SKEW_SECONDS = 15 * 60;

/** Mailgun: HMAC-SHA256(timestamp + token) with the account's HTTP webhook signing key (verified live against real routed requests). */
export function verifyMailgunSignature(timestamp: string, token: string, signature: string): boolean {
  if (unsignedWebhooksAllowed()) return true;
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key || !timestamp || !token || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = crypto.createHmac("sha256", key).update(timestamp + token).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Cron endpoints: a request is the scheduler only if CRON_SECRET is configured AND matches. Unset secret never means "open". */
export function isCronRequest(authorizationHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && authorizationHeader === `Bearer ${secret}`;
}
