import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronRequest } from "@/lib/webhook-security";
import { selectVoiceProvider, voiceReadiness } from "@/lib/voice/select";
import { getCallSettings, setCallSettings, localHourIn } from "@/lib/voice/call-settings";
import { logEvent } from "@/lib/log-event";

/**
 * The daily report call.
 *
 * Once a day, at the time each client chose, the agent rings the client's own
 * personal number and reads them the day's numbers (see /api/voice/twiml and
 * /api/voice/facts — the same data either way).
 *
 * Deliberate properties:
 *  - One call per client per day. The slot key is the client's LOCAL date, so an
 *    hourly cron (or a retry, or a manual trigger) cannot ring somebody twice.
 *  - The time is interpreted in the CLIENT's own timezone, not the server's.
 *  - Only clients who actually own an ACTIVE purchased number are considered,
 *    and the call is placed FROM that number TO the number the client entered —
 *    never an arbitrary pair.
 *  - If the voice provider is not configured, or spending is not enabled, it
 *    reports that and does nothing. It never half-places a call.
 *
 * Candidates come from client_phone_numbers rather than from the settings,
 * because the settings may live in auth metadata (see lib/voice/call-settings),
 * which cannot be filtered in SQL. Owning a number is the real precondition
 * anyway — without one there is nothing to dial from.
 */

interface Candidate {
  client_id: string;
  twilio_number: string;
}

async function run(req: NextRequest) {
  if (!isCronRequest(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const readiness = voiceReadiness();
  if (!readiness.ready || !readiness.purchaseEnabled) {
    return NextResponse.json({
      ok: true,
      called: 0,
      reason: `voice provider not ready (mode=${readiness.mode}; missing: ${readiness.missing.join(", ") || "none"}; VOICE_PURCHASE_ENABLED=${readiness.purchaseEnabled})`,
    });
  }
  const provider = selectVoiceProvider();
  if (!provider) return NextResponse.json({ ok: true, called: 0, reason: "no usable voice provider" });

  const admin = createAdminClient();
  const { data: numbers, error } = await admin
    .from("client_phone_numbers")
    .select("client_id, twilio_number")
    .eq("status", "active")
    .returns<Candidate[]>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Dev/test overrides.
  // Number(null) is 0, which used to make EVERY run think it was midnight and never call anyone.
  const hourParam = req.nextUrl.searchParams.get("hour");
  const hourOverride = hourParam === null || hourParam.trim() === "" ? NaN : Number(hourParam);
  const hasOverride = Number.isFinite(hourOverride) && hourOverride >= 0 && hourOverride <= 23;
  const clientFilter = req.nextUrl.searchParams.get("client_id");
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  const results: { client_id: string; result: string; detail?: string }[] = [];

  for (const row of numbers ?? []) {
    if (clientFilter && row.client_id !== clientFilter) continue;

    let settings;
    try {
      settings = await getCallSettings(admin, row.client_id);
    } catch (e) {
      results.push({ client_id: row.client_id, result: "error", detail: (e as Error).message });
      continue;
    }

    if (!settings.daily_call_enabled) continue;
    if (!settings.personal_phone_number) {
      results.push({ client_id: row.client_id, result: "skipped", detail: "no personal number" });
      continue;
    }

    const tz = settings.daily_call_timezone;
    const { date, hour, minute } = localHourIn(tz);
    if (!date) {
      results.push({ client_id: row.client_id, result: "skipped", detail: `unknown timezone ${tz}` });
      continue;
    }

    // Due once the chosen local time has passed, for a 2-hour grace window (the
    // scheduler ticks every few minutes, and a restart must not lose the day).
    // The per-day slot below guarantees a single call.
    const target = Number(settings.daily_call_time.slice(0, 2)) * 60 + Number(settings.daily_call_time.slice(3, 5));
    const nowMin = (hasOverride ? hourOverride : hour) * 60 + (hasOverride ? 0 : minute);
    if (nowMin < target || nowMin >= target + 120) continue;

    if (settings.daily_call_last_slot === date) {
      results.push({ client_id: row.client_id, result: "skipped", detail: "already called today" });
      continue;
    }

    if (dryRun) {
      results.push({ client_id: row.client_id, result: "would_call", detail: `${row.twilio_number} -> ${settings.personal_phone_number} at ${settings.daily_call_time} ${tz}` });
      continue;
    }

    try {
      const { callSid } = await provider.placeCall({
        from: row.twilio_number,
        to: settings.personal_phone_number,
        metadata: { client_id: row.client_id, reason: "daily_report", slot: date },
      });

      // Claim the slot only after the provider accepted the call, so a failure
      // does not burn the day.
      await setCallSettings(admin, row.client_id, {
        daily_call_last_slot: date,
        daily_call_last_at: new Date().toISOString(),
      });

      // Best-effort: client_calls gains its extra columns only after the
      // migration, so a failure here must not undo a placed call. Only the
      // columns that have always existed are written.
      const { error: insErr } = await admin.from("client_calls").insert({
        client_id: row.client_id,
        call_sid: callSid,
        direction: "outbound",
        duration_seconds: null,
        created_at: new Date().toISOString(),
      });
      if (insErr) {
        logEvent("voice.daily_call", { client_id: row.client_id, result: "call_row_failed", error: insErr.message });
      }

      logEvent("voice.daily_call", { client_id: row.client_id, result: "placed", call_sid: callSid });
      results.push({ client_id: row.client_id, result: "called" });
    } catch (err) {
      logEvent("voice.daily_call", { client_id: row.client_id, result: "failed", error: (err as Error).message });
      results.push({ client_id: row.client_id, result: "error", detail: (err as Error).message });
    }
  }

  return NextResponse.json({
    ok: true,
    called: results.filter((r) => r.result === "called").length,
    considered: (numbers ?? []).length,
    results,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
