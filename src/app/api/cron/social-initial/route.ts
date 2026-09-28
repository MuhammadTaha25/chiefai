import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronRequest } from "@/lib/webhook-security";
import { dueInitialRuns, processInitialRun, resetInitialRun } from "@/lib/social-initial";

/**
 * Processes first-connection validation cycles that have come due (~5 minutes
 * after the account was connected; the every-5-minutes schedule means 5 to 10 minutes).
 * Video generation is slow, hence the long maxDuration; a run that does not
 * finish resumes on the next tick from the steps it already recorded.
 *
 * Auth: Vercel Cron (Authorization: Bearer $CRON_SECRET).
 * QA override: ?client_id=<id>&now=1 runs that one client's pending cycle
 * immediately instead of waiting for the delay; add &reset=1 to start a fresh cycle after one completed.
 */
export const maxDuration = 300; // Hobby-plan ceiling. A Veo video can take longer, so video needs the Pro plan (raise this to 800 there).

export async function GET(req: NextRequest) {
  if (!isCronRequest(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const clientId = req.nextUrl.searchParams.get("client_id") ?? undefined;
  // ?reset=1 (with client_id) starts a fresh cycle for that client even if one already completed — QA only.
  if (clientId && req.nextUrl.searchParams.get("reset") === "1") await resetInitialRun(admin, clientId, undefined, 0);
  const runs = await dueInitialRuns(admin, clientId, req.nextUrl.searchParams.get("now") === "1" && Boolean(clientId));

  const results = [];
  // Sequential: each cycle may spend minutes rendering video.
  for (const run of runs) results.push(await processInitialRun(admin, run));
  return NextResponse.json({ ok: true, processed: results.length, results });
}
