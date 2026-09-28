import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Optional spoken PIN for INBOUND calls. Caller-ID can be spoofed, so when a PIN
 * is set the agent shares nothing until the caller says it. Only a salted scrypt
 * hash is stored (in the owner's auth metadata, next to the other call settings);
 * the PIN itself is never stored or logged.
 */
export const normalisePin = (s: string): string | null => (/^\d{4,6}$/.test(s.trim()) ? s.trim() : null);

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
}

export function checkPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pin, Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function authUser(admin: SupabaseClient, clientId: string) {
  const { data: c } = await admin.from("clients").select("auth_user_id").eq("id", clientId).maybeSingle<{ auth_user_id: string | null }>();
  if (!c?.auth_user_id) return null;
  const { data } = await admin.auth.admin.getUserById(c.auth_user_id);
  return data?.user ?? null;
}

export async function getPinHash(admin: SupabaseClient, clientId: string): Promise<string | null> {
  const u = await authUser(admin, clientId);
  return (u?.user_metadata?.voice_pin_hash as string | undefined) ?? null;
}

export async function setPinHash(admin: SupabaseClient, clientId: string, hash: string | null): Promise<void> {
  const u = await authUser(admin, clientId);
  if (!u) throw new Error("PIN needs a linked auth user for this client");
  const { error } = await admin.auth.admin.updateUserById(u.id, { user_metadata: { ...(u.user_metadata ?? {}), voice_pin_hash: hash } });
  if (error) throw new Error(`Could not save PIN: ${error.message}`);
}

// Per-client brute-force guard: 5 wrong PINs locks that client's line for 15 minutes.
const fails = new Map<string, { n: number; until: number }>();

export function pinLocked(clientId: string): boolean {
  const f = fails.get(clientId);
  return Boolean(f && f.until > Date.now());
}

export function recordPinResult(clientId: string, ok: boolean): void {
  if (ok) return void fails.delete(clientId);
  const n = (fails.get(clientId)?.n ?? 0) + 1;
  fails.set(clientId, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
}
