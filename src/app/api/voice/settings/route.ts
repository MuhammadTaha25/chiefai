import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCallSettings, setCallSettings, normalisePhone, normaliseTime, localHourIn } from "@/lib/voice/call-settings";
import { logEvent } from "@/lib/log-event";
import { getPinHash, hashPin, normalisePin, setPinHash } from "@/lib/voice/pin";

/**
 * The client's own daily-report call settings: WHICH number to ring them on,
 * whether to ring at all, at what local time, and in which timezone.
 *
 * These are the mirror image of the purchased number: `client_phone_numbers` is
 * the line the world calls, this is the owner's personal mobile that our agent
 * dials. The tenant comes from the session only.
 *
 * Storage is handled by lib/voice/call-settings, which uses the `clients`
 * columns when supabase/add_voice_agent.sql has been applied and otherwise
 * falls back to Supabase's auth user metadata — so the feature works before the
 * migration, and upgrades itself afterwards.
 */

export async function GET() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const settings = await getCallSettings(createAdminClient(), client.id);
    return NextResponse.json({ ok: true, available: true, settings, pin_set: Boolean(await getPinHash(createAdminClient(), client.id)) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  const admin = createAdminClient();
  const patch: Record<string, unknown> = {};

  if ("personal_phone_number" in body) {
    const raw = typeof body.personal_phone_number === "string" ? body.personal_phone_number.trim() : "";
    if (!raw) {
      patch.personal_phone_number = null;
      // Clearing the number must also stop the calls, otherwise the cron keeps
      // looking for somebody to dial who has no number.
      patch.daily_call_enabled = false;
    } else {
      const normalised = normalisePhone(raw);
      if (!normalised) {
        return NextResponse.json(
          { error: "Enter a valid phone number in international format, e.g. +923394816706" },
          { status: 400 }
        );
      }
      patch.personal_phone_number = normalised;
    }
  }

  if ("daily_call_enabled" in body) {
    if (body.daily_call_enabled && !("personal_phone_number" in body)) {
      const current = await getCallSettings(admin, client.id);
      if (!current.personal_phone_number) {
        return NextResponse.json({ error: "Add your phone number before turning daily calls on." }, { status: 400 });
      }
    }
    patch.daily_call_enabled = Boolean(body.daily_call_enabled);
  }

  if (typeof body.daily_call_time === "string") {
    const t = normaliseTime(body.daily_call_time);
    if (!t) return NextResponse.json({ error: "Invalid time — use HH:MM" }, { status: 400 });
    patch.daily_call_time = t;
  }

  if (typeof body.daily_call_timezone === "string" && body.daily_call_timezone.trim()) {
    const tz = body.daily_call_timezone.trim();
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    } catch {
      return NextResponse.json({ error: `Unknown timezone "${tz}"` }, { status: 400 });
    }
    patch.daily_call_timezone = tz;
  }

  // No number means nobody to ring: never leave "on" without one.
  if (patch.personal_phone_number === null) patch.daily_call_enabled = false;

  // The call is once per local day. If the owner moves the time (or the number) to
  // something that has not passed yet, today's slot must be reopened, otherwise the
  // new time silently never fires because a call already went out earlier today.
  if ("daily_call_time" in patch || "personal_phone_number" in patch) {
    const current = await getCallSettings(admin, client.id);
    const tz = (patch.daily_call_timezone as string | undefined) ?? current.daily_call_timezone;
    const newTime = (patch.daily_call_time as string | undefined) ?? current.daily_call_time;
    const changed =
      (patch.daily_call_time !== undefined && patch.daily_call_time !== current.daily_call_time) ||
      (typeof patch.personal_phone_number === "string" && patch.personal_phone_number !== current.personal_phone_number);
    const { hour, minute } = localHourIn(tz);
    const target = Number(newTime.slice(0, 2)) * 60 + Number(newTime.slice(3, 5));
    if (changed && hour >= 0 && target >= hour * 60 + minute - 15) patch.daily_call_last_slot = null;
  }

  // PIN: a string of 4-6 digits sets it, null removes it, "" / absent leaves it alone.
  let pinChange: string | null | undefined;
  if (body.voice_pin === null) pinChange = null;
  else if (typeof body.voice_pin === "string" && body.voice_pin.trim()) {
    const pin = normalisePin(body.voice_pin);
    if (!pin) return NextResponse.json({ error: "PIN must be 4 to 6 digits." }, { status: 400 });
    pinChange = hashPin(pin);
  }

  if (Object.keys(patch).length === 0 && pinChange === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    if (pinChange !== undefined) await setPinHash(admin, client.id, pinChange);
    const settings = Object.keys(patch).length ? await setCallSettings(admin, client.id, patch) : await getCallSettings(admin, client.id);
    logEvent("voice.settings_updated", { client_id: client.id, fields: Object.keys(patch).concat(pinChange !== undefined ? ["pin"] : []).join(",") });
    return NextResponse.json({ ok: true, settings });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
