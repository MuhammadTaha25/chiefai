import { NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { voicePurchaseEnabled } from "@/lib/voice/provider";
import { selectVoiceProvider, voiceReadiness } from "@/lib/voice/select";
import { getVoiceStatus, provisionVoiceNumber } from "@/lib/voice/provision";
import { logEvent } from "@/lib/log-event";

/**
 * Voice number provisioning: session tenant -> app state machine -> provider
 * (n8n holding Twilio/ElevenLabs, or Twilio directly when n8n is not set up)
 * -> client_phone_numbers.
 *
 * The tenant comes ONLY from the authenticated session. The request body is never
 * read, so a client_id (or anything else) supplied by the browser cannot matter.
 */

const UNAVAILABLE = "Voice number provisioning is currently unavailable. Please configure the voice provider first.";

async function tenant() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return null;
  return client.id as string;
}

/** Current state for the UI (also lets it poll while a provisioning is in flight). */
export async function GET() {
  const clientId = await tenant();
  if (!clientId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const status = await getVoiceStatus(createAdminClient(), clientId);
  const r = voiceReadiness();
  return NextResponse.json({ ...status, available: r.ready && r.purchaseEnabled, mode: r.mode });
}

export async function POST() {
  const clientId = await tenant();
  if (!clientId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // The provider (n8n, or Twilio directly) is only ever contacted when BOTH a
  // usable provider is configured AND the explicit VOICE_PURCHASE_ENABLED switch
  // is on. Otherwise the route answers "unavailable" (or returns an already-active
  // number) with zero outbound calls.
  const readiness = voiceReadiness();
  const enabled = readiness.ready && readiness.purchaseEnabled;
  let provider = null;
  let agentId = "";
  const countryCode = process.env.VOICE_COUNTRY_CODE?.trim().toUpperCase() || "US";
  if (enabled) {
    provider = selectVoiceProvider();
    agentId = (process.env.ELEVENLABS_AGENT_ID ?? "").trim();
  } else {
    // Variable NAMES / flag state only, server-side; never shown to the tenant.
    logEvent("voice.provision_unavailable", {
      client_id: clientId,
      mode: readiness.mode,
      missing: readiness.missing.join(","),
      purchase_enabled: voicePurchaseEnabled(),
    });
  }

  const result = await provisionVoiceNumber(createAdminClient(), clientId, provider, { configured: enabled, agentId, countryCode });

  switch (result.state) {
    case "active":
      return NextResponse.json({ ok: true, status: "active", phone_number: result.phoneNumber, existing: result.existing });
    case "in_progress":
      return NextResponse.json({ ok: true, status: "provisioning" }, { status: 202 });
    case "unavailable":
      return NextResponse.json({ error: UNAVAILABLE, status: "unavailable" }, { status: 503 });
    case "failed":
      return NextResponse.json({ error: result.error, status: "failed", retryable: result.retryable }, { status: 502 });
  }
}
