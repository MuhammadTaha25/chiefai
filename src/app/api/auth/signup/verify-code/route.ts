import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySignupCode } from "@/lib/signup-verification";

const REASON_MESSAGE: Record<string, string> = {
  not_found: "We couldn't find a pending verification for this email. Request a new code.",
  expired: "This code has expired. Request a new one.",
  already_verified: "This email is already verified.",
  wrong_code: "That code doesn't match. Check your email and try again.",
  too_many_attempts: "Too many incorrect attempts. Request a new code.",
};

export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = body.email?.trim();
  if (!email || (!body.code && !body.token)) {
    return NextResponse.json({ error: "Email and a code or link token are required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const result = await verifySignupCode(admin, email, { code: body.code?.trim(), token: body.token?.trim() });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: REASON_MESSAGE[result.reason] ?? "Verification failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
