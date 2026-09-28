import type { SupabaseClient } from "@supabase/supabase-js";
import { VoiceProviderError, type TwilioNumber, type VoiceProvider } from "@/lib/voice/provider";
import { logEvent } from "@/lib/log-event";

/**
 * Voice-number provisioning state machine (app -> Twilio -> ElevenLabs -> Supabase).
 *
 * Money safety, in layers:
 *  1. An already-active number short-circuits everything (no provider calls).
 *  2. A durable claim: the row phone_provisioning_requests(request_id = "voice:<client_id>")
 *     - request_id is UNIQUE in the database, so only one caller can hold the claim.
 *     Everyone else sees "in progress". A claim untouched for CLAIM_STALE_MS can be taken
 *     over; failed/completed rows are re-claimed with a conditional update.
 *  3. Provider-level idempotency: before buying, Twilio is asked whether this account
 *     already owns a number with this client's FriendlyName; if so it is ADOPTED, not re-bought.
 *  4. The purchased number is saved (status "inactive" = paid, not yet linked to the
 *     voice agent) BEFORE ElevenLabs is called, so an ElevenLabs/DB failure never loses or
 *     repeats the purchase: a retry resumes from the saved row.
 *  5. Purchasing additionally requires the explicit VOICE_PURCHASE_ENABLED switch (in provider.ts).
 */

const CLAIM_STALE_MS = 15 * 60 * 1000;
export const requestIdFor = (clientId: string) => `voice:${clientId}`;
export const friendlyNameFor = (clientId: string) => `Lead CRM ${clientId}`; // same tag the n8n workflow used, so its numbers are adopted too

export type ProvisionResult =
  | { state: "active"; phoneNumber: string; existing: boolean; elevenLabsPhoneNumberId: string | null }
  | { state: "in_progress" }
  | { state: "unavailable"; reason: "provider_not_configured" | "purchasing_disabled" }
  | { state: "failed"; error: string; retryable: boolean; partial: boolean };

export interface ProvisionOptions {
  configured: boolean; // Twilio + ElevenLabs credentials and agent id present
  agentId: string;
  countryCode: string;
}

interface PhoneRow {
  id: string;
  twilio_number: string;
  twilio_sid: string;
  status: string;
  elevenlabs_phone_number_id: string | null;
  released_at: string | null;
}

const COLS = "id, twilio_number, twilio_sid, status, elevenlabs_phone_number_id, released_at";

async function activeNumber(admin: SupabaseClient, clientId: string): Promise<PhoneRow | null> {
  const { data } = await admin.from("client_phone_numbers").select(COLS).eq("client_id", clientId).eq("status", "active").limit(1).maybeSingle<PhoneRow>();
  return data ?? null;
}

async function claim(admin: SupabaseClient, clientId: string): Promise<boolean> {
  const request_id = requestIdFor(clientId);
  const { error } = await admin.from("phone_provisioning_requests").insert({ client_id: clientId, request_id, status: "processing" });
  if (!error) return true;
  if (error.code !== "23505") throw new Error(`could not record provisioning request: ${error.message}`);

  const { data: row } = await admin.from("phone_provisioning_requests").select("status, updated_at").eq("request_id", request_id).eq("client_id", clientId).maybeSingle<{ status: string; updated_at: string }>();
  if (!row) return false;
  const now = new Date().toISOString();
  if (row.status === "processing") {
    if (Date.now() - new Date(row.updated_at).getTime() < CLAIM_STALE_MS) return false; // someone is working on it
    const { data } = await admin.from("phone_provisioning_requests").update({ status: "processing", error_message: null, updated_at: now }).eq("request_id", request_id).eq("status", "processing").eq("updated_at", row.updated_at).select("id");
    return !!data?.length; // conditional on the exact stale timestamp: only one taker wins
  }
  const { data } = await admin.from("phone_provisioning_requests").update({ status: "processing", error_message: null, updated_at: now }).eq("request_id", request_id).eq("status", row.status).select("id");
  return !!data?.length;
}

async function finishRequest(admin: SupabaseClient, clientId: string, status: "completed" | "failed", fields: { phone_number?: string; error_message?: string | null } = {}) {
  await admin.from("phone_provisioning_requests").update({ status, ...fields, updated_at: new Date().toISOString() }).eq("request_id", requestIdFor(clientId)).eq("client_id", clientId);
}

export async function provisionVoiceNumber(admin: SupabaseClient, clientId: string, provider: VoiceProvider | null, opts: ProvisionOptions): Promise<ProvisionResult> {
  // 1. Existing active number: return it, never buy another.
  const existing = await activeNumber(admin, clientId);
  if (existing) return { state: "active", phoneNumber: existing.twilio_number, existing: true, elevenLabsPhoneNumberId: existing.elevenlabs_phone_number_id };

  // 2. Not configured -> truthful "unavailable"; no claim, no provider call.
  if (!opts.configured || !provider) return { state: "unavailable", reason: "provider_not_configured" };

  // 3. Claim.
  if (!(await claim(admin, clientId))) return { state: "in_progress" };

  let purchased = false;
  try {
    // Re-check under the claim (another path may have finished in between).
    const raced = await activeNumber(admin, clientId);
    if (raced) {
      await finishRequest(admin, clientId, "completed", { phone_number: raced.twilio_number });
      return { state: "active", phoneNumber: raced.twilio_number, existing: true, elevenLabsPhoneNumberId: raced.elevenlabs_phone_number_id };
    }

    // 4a. Resume a partially provisioned number (paid, saved, not yet linked to the agent).
    const { data: partial } = await admin.from("client_phone_numbers").select(COLS).eq("client_id", clientId).eq("status", "inactive").is("released_at", null).not("twilio_sid", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle<PhoneRow>();
    let row: PhoneRow | null = partial ?? null;

    // 4b. Provider-level idempotency: the account may already own this client's number.
    if (!row) {
      const owned = await provider.findOwnedNumber(friendlyNameFor(clientId));
      if (owned) row = await saveInactive(admin, clientId, owned);
    }

    // 4c. Otherwise buy exactly one number (the only step that spends money).
    if (!row) {
      const wanted = await provider.searchAvailableNumber(opts.countryCode);
      if (!wanted) {
        await finishRequest(admin, clientId, "failed", { error_message: `No voice-enabled number is available for ${opts.countryCode}` });
        return { state: "failed", error: `No voice-enabled number is available for ${opts.countryCode}. Try again later.`, retryable: true, partial: false };
      }
      let bought: TwilioNumber;
      try {
        bought = await provider.purchaseNumber(wanted, friendlyNameFor(clientId));
      } catch (e) {
        if (e instanceof VoiceProviderError && e.kind === "config") {
          await finishRequest(admin, clientId, "failed", { error_message: "purchasing_disabled" });
          return { state: "unavailable", reason: "purchasing_disabled" };
        }
        throw e; // includes timeouts: outcome unknown -> retry adopts via FriendlyName, never re-buys blindly
      }
      purchased = true;
      row = await saveInactive(admin, clientId, bought); // persisted BEFORE ElevenLabs
    }

    // 5. ElevenLabs.
    const elId = await provider.importToElevenLabs({ phoneNumber: row.twilio_number, sid: row.twilio_sid }, "Lead CRM Voice Line", opts.agentId);

    // 6. Activate - but never onto a number another tenant already holds (routing is by called number).
    const { data: heldElsewhere } = await admin.from("client_phone_numbers").select("client_id").eq("twilio_number", row.twilio_number).eq("status", "active").neq("client_id", clientId).limit(1);
    if (heldElsewhere?.length) throw new Error("this number is already assigned to another account; refusing to activate it");
    const { error: actErr } = await admin.from("client_phone_numbers").update({ status: "active", provider: "twilio", elevenlabs_phone_number_id: elId, elevenlabs_agent_id: opts.agentId, provisioned_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", row.id).eq("client_id", clientId);
    if (actErr) throw new Error(`could not activate the number: ${actErr.message}`);

    await finishRequest(admin, clientId, "completed", { phone_number: row.twilio_number });
    logEvent("voice.provisioned", { client_id: clientId, result: "active", bought_now: purchased });
    return { state: "active", phoneNumber: row.twilio_number, existing: false, elevenLabsPhoneNumberId: elId };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    const retryable = e instanceof VoiceProviderError ? e.retryable : true;
    await finishRequest(admin, clientId, "failed", { error_message: message.slice(0, 300) }).catch(() => {});
    // partial = a paid number exists (or may exist) and is kept; a retry resumes it instead of buying again.
    logEvent("voice.provisioned", { client_id: clientId, result: "failed", partial: purchased, error: message });
    return { state: "failed", error: "Provisioning did not complete. Your number (if one was purchased) is kept and will be reused when you retry.", retryable, partial: purchased };
  }
}

async function saveInactive(admin: SupabaseClient, clientId: string, n: TwilioNumber): Promise<PhoneRow> {
  const { data, error } = await admin
    .from("client_phone_numbers")
    .insert({ client_id: clientId, twilio_number: n.phoneNumber, twilio_sid: n.sid, provider: "twilio", status: "inactive" })
    .select(COLS)
    .single<PhoneRow>();
  if (!error && data) return data;
  // The number may already be stored (retry after a partial run): reuse that row.
  const { data: again } = await admin.from("client_phone_numbers").select(COLS).eq("client_id", clientId).eq("twilio_sid", n.sid).limit(1).maybeSingle<PhoneRow>();
  if (again) return again;
  throw new Error(`PURCHASED ${n.phoneNumber} but could not save it (${error?.message}); a retry will adopt it from Twilio`);
}

export type VoiceStatus =
  | { state: "active"; phoneNumber: string; agentLinked: boolean }
  | { state: "provisioning" }
  | { state: "failed"; retryable: true }
  | { state: "none" };

/** Read-only status for the UI. Tenant-scoped by the caller-supplied (session-derived) clientId. */
export async function getVoiceStatus(admin: SupabaseClient, clientId: string): Promise<VoiceStatus> {
  const a = await activeNumber(admin, clientId);
  if (a) return { state: "active", phoneNumber: a.twilio_number, agentLinked: !!a.elevenlabs_phone_number_id };
  const { data } = await admin.from("phone_provisioning_requests").select("status, updated_at").eq("request_id", requestIdFor(clientId)).eq("client_id", clientId).maybeSingle<{ status: string; updated_at: string }>();
  if (data?.status === "processing" && Date.now() - new Date(data.updated_at).getTime() < CLAIM_STALE_MS) return { state: "provisioning" };
  if (data?.status === "failed" || data?.status === "processing") return { state: "failed", retryable: true };
  return { state: "none" };
}

/**
 * Inbound-call routing rule: the CALLED number decides the tenant - never a caller,
 * frontend or AI-supplied client id. (Live routing runs in the ElevenLabs agent's
 * tool webhooks, which resolve the called number through this same table.)
 */
export async function resolveClientByCalledNumber(admin: SupabaseClient, calledNumber: string): Promise<string | null> {
  const { data } = await admin.from("client_phone_numbers").select("client_id").eq("twilio_number", calledNumber.trim()).eq("status", "active").limit(2);
  // Fail closed: an ambiguous number (held by more than one tenant) resolves to nobody.
  return data?.length === 1 ? (data[0].client_id as string) : null;
}
