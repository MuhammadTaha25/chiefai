import crypto from "crypto";

/**
 * Server-only. Per-client Calendly webhook subscription (spec PHASE 8/9) —
 * one subscription per client's own organization/user, scoped to their own
 * access token, so a booking webhook can only ever be about that client's
 * own leads.
 */
export async function createCalendlyWebhookSubscription(params: {
  accessToken: string;
  organizationUri: string;
  userUri: string;
  callbackUrl: string;
}): Promise<{ uri: string; signingKey: string }> {
  const res = await fetch("https://api.calendly.com/webhook_subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: params.callbackUrl,
      events: ["invitee.created", "invitee.canceled"],
      organization: params.organizationUri,
      user: params.userUri,
      scope: "user",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Calendly webhook subscription failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // Calendly returns the signing key only in this creation response — it
  // must be persisted now, there's no way to retrieve it again later.
  const signingKey = data.resource?.signing_key as string | undefined;
  const uri = data.resource?.uri as string | undefined;
  if (!signingKey || !uri) {
    throw new Error(`Calendly webhook subscription response missing signing_key/uri: ${JSON.stringify(data)}`);
  }
  return { uri, signingKey };
}

export async function deleteCalendlyWebhookSubscription(accessToken: string, webhookUri: string) {
  await fetch(webhookUri, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {});
}

/**
 * Verifies Calendly's `Calendly-Webhook-Signature` header: "t=<ts>,v1=<hmac>"
 * — HMAC-SHA256 of "<ts>.<rawBody>" using the subscription's own signing key.
 */
export function verifyCalendlySignature(rawBody: string, header: string | null, signingKey: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac("sha256", signingKey).update(`${t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}

interface ClientCalendlyRow {
  id: string;
  calendly_access_token: string | null;
  calendly_refresh_token: string | null;
  calendly_token_expires_at: string | null;
  calendly_user_uri: string | null;
}

/**
 * Returns a usable access token for this client, refreshing (and persisting
 * the rotated tokens) when it is expired or about to be. Calendly access
 * tokens live ~2h — without this, anything that calls the API after the
 * initial connect silently starts failing with 401.
 */
export async function getFreshCalendlyToken(
  admin: import("@supabase/supabase-js").SupabaseClient,
  client: ClientCalendlyRow
): Promise<string | null> {
  if (!client.calendly_access_token) return null;
  const expiresAt = client.calendly_token_expires_at ? new Date(client.calendly_token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 120_000) return client.calendly_access_token;
  if (!client.calendly_refresh_token) return null;

  const res = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: client.calendly_refresh_token,
      client_id: process.env.CALENDLY_CLIENT_ID ?? "",
      client_secret: process.env.CALENDLY_CLIENT_SECRET ?? "",
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token) return null;
  await admin
    .from("clients")
    .update({
      calendly_access_token: t.access_token,
      calendly_refresh_token: t.refresh_token ?? client.calendly_refresh_token,
      calendly_token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
    })
    .eq("id", client.id);
  return t.access_token;
}

export interface CalendlyInvitee {
  inviteeUri: string;
  email: string;
  status: string;
  startTime: string;
  endTime: string;
  eventTypeUri: string | null;
  scheduledEventUri: string;
}

/** Lists invitees of this user's events from `sinceIso` on (works on Calendly's free plan — unlike webhooks). */
export async function listRecentInvitees(accessToken: string, userUri: string, sinceIso: string): Promise<CalendlyInvitee[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const evRes = await fetch(
    `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${encodeURIComponent(sinceIso)}&count=100&sort=start_time:asc`,
    { headers }
  );
  if (!evRes.ok) throw new Error(`Calendly scheduled_events failed: ${evRes.status}`);
  const events = ((await evRes.json()).collection ?? []) as {
    uri: string;
    start_time: string;
    end_time: string;
    event_type: string;
  }[];
  const out: CalendlyInvitee[] = [];
  for (const ev of events) {
    const uuid = ev.uri.split("/").pop();
    const invRes = await fetch(`https://api.calendly.com/scheduled_events/${uuid}/invitees?count=100`, { headers });
    if (!invRes.ok) continue;
    for (const inv of ((await invRes.json()).collection ?? []) as { uri: string; email: string; status: string }[]) {
      out.push({
        inviteeUri: inv.uri,
        email: inv.email,
        status: inv.status,
        startTime: ev.start_time,
        endTime: ev.end_time,
        eventTypeUri: ev.event_type ?? null,
        scheduledEventUri: ev.uri,
      });
    }
  }
  return out;
}
