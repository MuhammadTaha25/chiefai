import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-client daily-report call settings.
 *
 * WHERE THIS LIVES, AND WHY IT MOVES
 *
 * The intended home is the `clients` columns added by
 * supabase/add_voice_agent.sql (personal_phone_number, daily_call_enabled,
 * daily_call_time, daily_call_timezone, daily_call_last_slot, daily_call_last_at).
 *
 * That migration has NOT been applied to this project, and the app cannot apply
 * DDL itself, so the feature would otherwise be dead. Supabase's auth
 * user-metadata API is a supported, keyed store that needs no schema change, so
 * that is the fallback: the settings live under
 * `auth.users.raw_user_meta_data.voice_call_settings`.
 *
 * This module prefers the COLUMNS whenever they exist and only falls back to
 * metadata otherwise, so running the migration later upgrades the storage with
 * no code change. Detection is cached per process so we do not pay for a failing
 * query on every request.
 *
 * Tenant safety is unchanged either way: the caller passes a clientId it
 * resolved server-side (session, or the dialled number), and the metadata is
 * read/written on that client's OWN auth user.
 */

export interface CallSettings {
  personal_phone_number: string | null;
  daily_call_enabled: boolean;
  daily_call_time: string; // "HH:MM"
  daily_call_timezone: string;
  daily_call_last_at: string | null;
  daily_call_last_slot: string | null;
}

export const DEFAULTS: Omit<CallSettings, "personal_phone_number" | "daily_call_last_at" | "daily_call_last_slot"> = {
  daily_call_enabled: false,
  daily_call_time: "18:00",
  daily_call_timezone: "Asia/Karachi",
};

/** Loose E.164: a leading + and 8–15 digits. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s()\-.]/g, "");
  if (!/^\+?\d{8,15}$/.test(digits)) return null;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/** "18:00", "18:00:00" -> "18:00"; anything else -> null. */
export function normaliseTime(input: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** -1 = unknown timezone (never silently shift somebody's call time). */
export function localHourIn(tz: string): { date: string; hour: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
  } catch {
    return { date: "", hour: -1, minute: 0 };
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}

// --- storage detection -------------------------------------------------------
let columnsAvailable: boolean | null = null;

async function hasColumns(admin: SupabaseClient): Promise<boolean> {
  if (columnsAvailable !== null) return columnsAvailable;
  const { error } = await admin.from("clients").select("daily_call_enabled").limit(1);
  columnsAvailable = !error;
  return columnsAvailable;
}

/** Testing/ops hook so a stale detection is not cached forever. */
export function resetStorageDetection(): void {
  columnsAvailable = null;
}

async function authUserIdOf(admin: SupabaseClient, clientId: string): Promise<string | null> {
  const { data } = await admin
    .from("clients")
    .select("auth_user_id")
    .eq("id", clientId)
    .maybeSingle<{ auth_user_id: string | null }>();
  return data?.auth_user_id ?? null;
}

async function readMeta(admin: SupabaseClient, clientId: string): Promise<CallSettings> {
  const uid = await authUserIdOf(admin, clientId);
  if (!uid) return { ...DEFAULTS, personal_phone_number: null, daily_call_last_at: null, daily_call_last_slot: null };
  const { data, error } = await admin.auth.admin.getUserById(uid);
  if (error || !data?.user) {
    throw new Error(`Could not read call settings: ${error?.message ?? "user not found"}`);
  }
  const raw = (data.user.user_metadata?.voice_call_settings ?? {}) as Partial<CallSettings>;
  return {
    personal_phone_number: raw.personal_phone_number ?? null,
    daily_call_enabled: raw.daily_call_enabled ?? DEFAULTS.daily_call_enabled,
    daily_call_time: raw.daily_call_time ?? DEFAULTS.daily_call_time,
    daily_call_timezone: raw.daily_call_timezone ?? DEFAULTS.daily_call_timezone,
    daily_call_last_at: raw.daily_call_last_at ?? null,
    daily_call_last_slot: raw.daily_call_last_slot ?? null,
  };
}

async function writeMeta(admin: SupabaseClient, clientId: string, patch: Partial<CallSettings>): Promise<CallSettings> {
  const uid = await authUserIdOf(admin, clientId);
  if (!uid) throw new Error("Call settings need a linked auth user for this client");
  const { data, error } = await admin.auth.admin.getUserById(uid);
  if (error || !data?.user) throw new Error(`Could not read call settings: ${error?.message ?? "user not found"}`);
  const next = { ...((data.user.user_metadata?.voice_call_settings ?? {}) as Record<string, unknown>), ...patch };
  const { error: wErr } = await admin.auth.admin.updateUserById(uid, {
    // Merge at the top level too — other metadata keys must survive.
    user_metadata: { ...(data.user.user_metadata ?? {}), voice_call_settings: next },
  });
  if (wErr) throw new Error(`Could not save call settings: ${wErr.message}`);
  return readMeta(admin, clientId);
}

// --- public API --------------------------------------------------------------

export async function getCallSettings(admin: SupabaseClient, clientId: string): Promise<CallSettings> {
  if (await hasColumns(admin)) {
    const { data, error } = await admin
      .from("clients")
      .select("personal_phone_number, daily_call_enabled, daily_call_time, daily_call_timezone, daily_call_last_at, daily_call_last_slot")
      .eq("id", clientId)
      .maybeSingle<CallSettings>();
    if (!error && data) {
      return {
        personal_phone_number: data.personal_phone_number ?? null,
        daily_call_enabled: data.daily_call_enabled ?? false,
        daily_call_time: normaliseTime(String(data.daily_call_time ?? "")) ?? DEFAULTS.daily_call_time,
        daily_call_timezone: data.daily_call_timezone ?? DEFAULTS.daily_call_timezone,
        daily_call_last_at: data.daily_call_last_at ?? null,
        daily_call_last_slot: data.daily_call_last_slot ?? null,
      };
    }
  }
  return readMeta(admin, clientId);
}

export async function setCallSettings(
  admin: SupabaseClient,
  clientId: string,
  patch: Partial<CallSettings>
): Promise<CallSettings> {
  if (await hasColumns(admin)) {
    const { error } = await admin.from("clients").update(patch).eq("id", clientId);
    if (!error) return getCallSettings(admin, clientId);
  }
  return writeMeta(admin, clientId, patch);
}
