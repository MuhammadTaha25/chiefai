import { NextResponse } from "next/server";

// Temporary debug endpoint — remove before merging to main.
// GET /api/debug/zernio-accounts
// Returns the raw Zernio /accounts response so we can see what ad account
// IDs are linked to each connected page.
export async function GET() {
  const apiKey = process.env.ZERNIO_API_KEY_GOOGLE_META;
  const baseUrl = process.env.ZERNIO_BASE_URL;

  if (!apiKey || !baseUrl) {
    return NextResponse.json({ error: "ZERNIO env vars not set" }, { status: 500 });
  }

  const res = await fetch(`${baseUrl}/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const data = await res.json().catch(() => null);
  return NextResponse.json({ status: res.status, data });
}
