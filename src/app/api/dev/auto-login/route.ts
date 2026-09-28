import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Local-dev-only shortcut so protected pages (/domains, /settings, ...) can
 * be tested without re-typing credentials each time — hard-gated to
 * development so this can never fire in a deployed environment. Signs into
 * the existing test client account (DEV_AUTOLOGIN_EMAIL/PASSWORD in
 * .env.local) through the real Supabase auth flow — no auth bypass, just
 * skipping the manual form.
 */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const email = process.env.DEV_AUTOLOGIN_EMAIL;
  const password = process.env.DEV_AUTOLOGIN_PASSWORD;
  if (!email || !password) {
    return NextResponse.json({ error: "DEV_AUTOLOGIN_EMAIL/PASSWORD not set in .env.local" }, { status: 500 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  const requested = req.nextUrl.searchParams.get("next") || "/domains";
  // same-site paths only (no open redirect, even in dev)
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/domains";
  return NextResponse.redirect(new URL(next, req.nextUrl.origin));
}
