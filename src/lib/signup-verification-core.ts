/**
 * Pure decision logic for signup email verification: a 6-digit code + a link
 * token, either of which completes verification. No Supabase/n8n/fetch calls
 * here — those live in signup-verification.ts. Injected `deps` makes this
 * testable with an in-memory fake, same shape as domain-ownership-core.ts.
 */

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

export interface VerificationRow {
  code: string;
  token: string;
  status: "pending" | "verified" | "expired";
  attempts: number;
  expiresAtISO: string;
}

export interface VerificationDeps {
  getLatestForEmail(email: string): Promise<VerificationRow | null>;
  insertVerification(email: string, code: string, token: string, expiresAtISO: string): Promise<void>;
  incrementAttempts(email: string): Promise<void>;
  markVerified(email: string): Promise<void>;
  randomCode(): string;
  randomToken(): string;
  now(): Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function startVerification(
  deps: VerificationDeps,
  emailInput: string
): Promise<{ email: string; code: string; token: string; expiresAtISO: string }> {
  const email = normalizeEmail(emailInput);
  const code = deps.randomCode();
  const token = deps.randomToken();
  const expiresAtISO = new Date(deps.now().getTime() + CODE_TTL_MS).toISOString();
  await deps.insertVerification(email, code, token, expiresAtISO);
  return { email, code, token, expiresAtISO };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "already_verified" | "wrong_code" | "too_many_attempts" };

/** Verify by the 6-digit code the user typed in, or by the token from the emailed link (whichever is supplied). */
export async function checkVerification(
  deps: VerificationDeps,
  emailInput: string,
  submitted: { code?: string; token?: string }
): Promise<VerifyResult> {
  const email = normalizeEmail(emailInput);
  const row = await deps.getLatestForEmail(email);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "verified") return { ok: true };
  if (deps.now().getTime() > new Date(row.expiresAtISO).getTime()) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const matches = submitted.token ? submitted.token === row.token : submitted.code === row.code;
  if (!matches) {
    await deps.incrementAttempts(email);
    return { ok: false, reason: "wrong_code" };
  }

  await deps.markVerified(email);
  return { ok: true };
}
