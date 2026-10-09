/**
 * Real wiring for signup-verification-core.ts: the signup_email_verifications
 * table (service-role only — see supabase/add_signup_email_verification.sql)
 * and the email send.
 *
 * The email goes through a dedicated n8n webhook ("Infomist - Signup
 * Verification Email", active, SMTP-backed via n8n's existing SMTP
 * credential, generic {to, subject, text} payload). It sends FROM
 * murtazamajid.123@gmail.com specifically — sending from appointment@infomist.com
 * (infomist.com has no SPF/DKIM authorizing this relay) was accepted by the
 * SMTP hop but never actually arrived; the Gmail sender fixed delivery.
 */
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  startVerification as startVerificationCore,
  checkVerification as checkVerificationCore,
  normalizeEmail,
  type VerificationDeps,
  type VerificationRow,
  type VerifyResult,
} from "@/lib/signup-verification-core";

const N8N_EMAIL_WEBHOOK_PATH = "/webhook/infomist/signup-verification-email";
const TIMEOUT_MS = 15_000;

export function missingSignupVerificationConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["N8N_BASE_URL"].filter((k) => !env[k]?.trim());
}

function randomCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function realDeps(admin: SupabaseClient): VerificationDeps {
  return {
    async getLatestForEmail(email) {
      const { data } = await admin
        .from("signup_email_verifications")
        .select("code, token, status, attempts, expires_at")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ code: string; token: string; status: VerificationRow["status"]; attempts: number; expires_at: string }>();
      if (!data) return null;
      return { code: data.code, token: data.token, status: data.status, attempts: data.attempts, expiresAtISO: data.expires_at };
    },
    async insertVerification(email, code, token, expiresAtISO) {
      await admin.from("signup_email_verifications").insert({ email, code, token, expires_at: expiresAtISO });
    },
    async incrementAttempts(email) {
      const { data } = await admin
        .from("signup_email_verifications")
        .select("id, attempts")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; attempts: number }>();
      if (data) await admin.from("signup_email_verifications").update({ attempts: data.attempts + 1 }).eq("id", data.id);
    },
    async markVerified(email) {
      await admin
        .from("signup_email_verifications")
        .update({ status: "verified", verified_at: new Date().toISOString() })
        .eq("email", email)
        .eq("status", "pending");
    },
    randomCode,
    randomToken: () => crypto.randomBytes(24).toString("hex"),
    now: () => new Date(),
  };
}

async function sendVerificationEmail(env: NodeJS.ProcessEnv, email: string, code: string, token: string, appUrl: string): Promise<void> {
  const base = env.N8N_BASE_URL!.trim().replace(/\/$/, "");
  const link = `${appUrl.replace(/\/$/, "")}/verify-email?email=${encodeURIComponent(email)}&token=${token}`;
  const text = [
    `Your Infomist verification code is: ${code}`,
    ``,
    `It expires in 15 minutes.`,
    ``,
    `Or click this link to verify automatically:`,
    link,
  ].join("\n");

  let res: Response;
  try {
    res = await fetch(`${base}${N8N_EMAIL_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: email, subject: "Your Infomist verification code", text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Verification email send failed (network): ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Verification email send failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

export async function sendSignupVerification(
  admin: SupabaseClient,
  env: NodeJS.ProcessEnv,
  emailInput: string,
  appUrl: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const missing = missingSignupVerificationConfig(env);
  if (missing.length) return { ok: false, error: `Email verification is not configured (${missing.join(", ")})` };

  const email = normalizeEmail(emailInput);
  const { code, token } = await startVerificationCore(realDeps(admin), email);
  try {
    await sendVerificationEmail(env, email, code, token, appUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

export async function verifySignupCode(
  admin: SupabaseClient,
  emailInput: string,
  submitted: { code?: string; token?: string }
): Promise<VerifyResult> {
  return checkVerificationCore(realDeps(admin), emailInput, submitted);
}
