import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { callLeadsMcpTool, getRedirectUri } from "@/lib/leads-mcp";

/**
 * Any client of this app can search leads through here — credits are drawn
 * from the single Frontage Leads account connected via /api/leads/connect,
 * not from anything per-client.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const filters = await req.json();
  const redirectUri = getRedirectUri(resolveAppOrigin(req, { preferEnv: false }));

  try {
    const result = await callLeadsMcpTool("search_leads", filters, redirectUri);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
