import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The "bridge": every external service that has to point AT this app.
 *
 * A tunnel gives us a new origin every time it restarts, and the moment it
 * changes two things silently rot:
 *
 *   1. The Zernio webhook subscriptions still POST to the old origin, so no
 *      comment/DM event ever arrives again.
 *   2. Every Twilio number we bought still has the old origin as its VoiceUrl,
 *      so calling it reaches nothing.
 *
 * Both were previously only ever set once, at setup time, which is exactly why
 * the bridge felt temporary. `syncPublicEndpoints()` re-points BOTH at the
 * current origin, so a restart repairs itself instead of needing a rebuild.
 *
 * It is deliberately idempotent and cheap: anything already correct is left
 * alone, so it is safe to call on a schedule.
 */

const ZERNIO_BASE = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";
const TWILIO_API = "https://api.twilio.com/2010-04-01";

export interface EndpointChange {
  target: string;
  action: "updated" | "already-correct" | "skipped" | "failed";
  detail?: string;
}

export interface EndpointSyncResult {
  origin: string;
  configured: boolean;
  zernio: EndpointChange[];
  twilio: EndpointChange[];
}

function scrub(text: string, secrets: (string | undefined)[]): string {
  let t = String(text).slice(0, 300);
  for (const s of secrets) if (s) t = t.split(s).join("[redacted]");
  return t.replace(/\b(AC|SK)[0-9a-fA-F]{28,}\b/g, "[redacted]");
}

async function zernioFetch(path: string, key: string, init?: RequestInit) {
  const res = await fetch(`${ZERNIO_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init?.headers },
  });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Re-point the Zernio webhook subscriptions at `origin`.
 * One subscription per API-key group; anything that is not ours is left alone.
 */
async function syncZernio(origin: string): Promise<EndpointChange[]> {
  const groups: { name: string; key?: string }[] = [
    { name: "google_meta", key: process.env.ZERNIO_API_KEY_GOOGLE_META },
    { name: "tiktok_instagram", key: process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM },
  ];
  const want = `${origin}/api/webhooks/zernio`;
  const out: EndpointChange[] = [];
  const secrets = groups.map((g) => g.key).concat([process.env.ZERNIO_WEBHOOK_SECRET]);

  for (const g of groups) {
    if (!g.key) { out.push({ target: `zernio:${g.name}`, action: "skipped", detail: "no API key" }); continue; }
    const list = await zernioFetch("/webhooks/settings", g.key);
    if (!list.ok || !Array.isArray((list.json as { webhooks?: unknown[] })?.webhooks)) {
      out.push({ target: `zernio:${g.name}`, action: "failed", detail: scrub(`list ${list.status} ${list.text}`, secrets) });
      continue;
    }
    const webhooks = (list.json as { webhooks: { _id: string; url: string; isActive?: boolean; name?: string }[] }).webhooks;
    // Ours = the one that already targets our webhook path, active or not.
    const ours = webhooks.filter((w) => String(w.url).includes("/api/webhooks/zernio"));

    if (ours.length === 0) {
      // Nothing registered yet — create it so the bridge exists at all.
      const created = await zernioFetch("/webhooks/settings", g.key, {
        method: "POST",
        body: JSON.stringify({
          name: "Infomist auto-reply",
          url: want,
          secret: process.env.ZERNIO_WEBHOOK_SECRET ?? "",
          events: ["comment.received", "message.received"],
        }),
      });
      out.push(
        created.ok
          ? { target: `zernio:${g.name}`, action: "updated", detail: "created" }
          : { target: `zernio:${g.name}`, action: "failed", detail: scrub(`create ${created.status} ${created.text}`, secrets) }
      );
      continue;
    }

    for (const w of ours) {
      if (w.url === want && w.isActive !== false) {
        out.push({ target: `zernio:${g.name}`, action: "already-correct" });
        continue;
      }
      const updated = await zernioFetch("/webhooks/settings", g.key, {
        method: "PUT",
        // Keep the secret if one is already registered and none is configured,
        // so re-pointing the URL can never silently weaken the signature check.
        body: JSON.stringify({
          _id: w._id,
          url: want,
          isActive: true,
          ...(process.env.ZERNIO_WEBHOOK_SECRET ? { secret: process.env.ZERNIO_WEBHOOK_SECRET } : {}),
        }),
      });
      out.push(
        updated.ok
          ? { target: `zernio:${g.name}`, action: "updated", detail: `${w.url} -> ${want}` }
          : { target: `zernio:${g.name}`, action: "failed", detail: scrub(`update ${updated.status} ${updated.text}`, secrets) }
      );
    }
  }
  return out;
}

/**
 * Re-point every Twilio number WE own at `origin`, by matching the numbers in
 * client_phone_numbers — never the account's other numbers, which may belong to
 * something else entirely (the ElevenLabs lines, for instance).
 */
async function syncTwilio(admin: SupabaseClient, origin: string): Promise<EndpointChange[]> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return [{ target: "twilio", action: "skipped", detail: "no credentials" }];

  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const want = `${origin}/api/voice/twiml`;

  const { data: rows } = await admin
    .from("client_phone_numbers")
    .select("twilio_number, twilio_sid, status, elevenlabs_phone_number_id")
    .eq("status", "active");
  if (!rows?.length) return [{ target: "twilio", action: "skipped", detail: "no active numbers of ours" }];

  const listRes = await fetch(`${TWILIO_API}/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`, {
    headers: { Authorization: auth },
  });
  if (!listRes.ok) return [{ target: "twilio", action: "failed", detail: scrub(`list ${listRes.status}`, [token]) }];
  const list = (await listRes.json()) as { incoming_phone_numbers?: { sid: string; phone_number: string; voice_url?: string }[] };

  const out: EndpointChange[] = [];
  for (const row of rows) {
    // A number that was deliberately imported into ElevenLabs carries a real
    // phnum_… id. Re-pointing it here would silently take it away from the
    // ElevenLabs agent the client set up, so it is left exactly as it is. Only
    // numbers this app manages (no id, or our own "local:" marker) are moved.
    const elId = row.elevenlabs_phone_number_id as string | null;
    if (elId && !elId.startsWith("local:")) {
      out.push({ target: `twilio:${row.twilio_number}`, action: "skipped", detail: "managed by ElevenLabs" });
      continue;
    }

    const live = (list.incoming_phone_numbers ?? []).find((n) => n.phone_number === row.twilio_number);
    if (!live) { out.push({ target: `twilio:${row.twilio_number}`, action: "failed", detail: "not on the Twilio account" }); continue; }
    if (live.voice_url === want) { out.push({ target: `twilio:${row.twilio_number}`, action: "already-correct" }); continue; }

    const upd = await fetch(`${TWILIO_API}/Accounts/${sid}/IncomingPhoneNumbers/${live.sid}.json`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ VoiceUrl: want, VoiceMethod: "POST" }),
    });
    out.push(
      upd.ok
        ? { target: `twilio:${row.twilio_number}`, action: "updated", detail: `${live.voice_url ?? "(none)"} -> ${want}` }
        : { target: `twilio:${row.twilio_number}`, action: "failed", detail: scrub(`update ${upd.status}`, [token]) }
    );
  }
  return out;
}

/**
 * Point everything at `origin`. Pass the current PUBLIC_APP_URL explicitly so
 * the caller decides, rather than this reading the env behind their back.
 */
export async function syncPublicEndpoints(
  admin: SupabaseClient,
  origin: string
): Promise<EndpointSyncResult> {
  const clean = origin.replace(/\/$/, "");
  if (!/^https?:\/\//.test(clean)) {
    return { origin: clean, configured: false, zernio: [], twilio: [{ target: "origin", action: "failed", detail: "not an absolute URL" }] };
  }
  const zernio = await syncZernio(clean).catch((e) => [{ target: "zernio", action: "failed" as const, detail: (e as Error).message }]);
  const twilio = await syncTwilio(admin, clean).catch((e) => [{ target: "twilio", action: "failed" as const, detail: (e as Error).message }]);
  return { origin: clean, configured: true, zernio, twilio };
}

/**
 * Is the bridge actually reachable from the outside right now? A tunnel that is
 * up but serving somebody else's error page looks identical to a healthy one
 * from inside the process, so this asks the public URL directly.
 */
export async function checkBridgeHealth(origin: string): Promise<{ reachable: boolean; status?: number; detail?: string }> {
  const url = `${origin.replace(/\/$/, "")}/api/voice/twiml`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
    return { reachable: res.ok, status: res.status };
  } catch (e) {
    return { reachable: false, detail: (e as Error).message };
  }
}
