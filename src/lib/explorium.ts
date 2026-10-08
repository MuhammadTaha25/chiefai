/**
 * Server-only. Prospecting data source — the actual "find 5 leads matching
 * this ICP" step. Explorium (explorium.ai) is the real B2B data provider
 * behind the "Vibe Prospecting" MCP tool available in chat, but that MCP
 * tool only works inside an AI agent session — it cannot be called from a
 * live, unattended Next.js server. This wraps Explorium's own REST API
 * directly instead, using a separate API key from explorium.ai.
 *
 * NOT YET CONFIGURED: EXPLORIUM_API_KEY isn't set. Sign up at
 * https://explorium.ai, grab an API key, and set EXPLORIUM_API_KEY in
 * .env.local — /api/leads/generate will start actually prospecting instead
 * of leaving jobs at status "blocked_missing_prospecting_key".
 */
const EXPLORIUM_API_KEY = process.env.EXPLORIUM_API_KEY;
const EXPLORIUM_BASE_URL = process.env.EXPLORIUM_BASE_URL ?? "https://api.explorium.ai/v2";

export function isExploriumConfigured() {
  return Boolean(EXPLORIUM_API_KEY);
}

export interface ProspectResult {
  name: string;
  email: string | null;
  company: string;
  jobTitle: string | null;
}

export interface ProspectQuery {
  industries: string[];
  companySizeRange: string;
  jobTitles: string[];
  keywords: string[];
  limit: number;
}

/**
 * Narrow, defensive runtime check for one prospect row — Explorium's exact
 * response shape was never confirmed against a live account (see the KNOWN
 * GAP above findProspects), so every field is validated rather than
 * trusted. A row that doesn't match this shape is dropped, not thrown: one
 * malformed record must never take down the whole batch.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceProspectRow(raw: unknown): ProspectResult | null {
  if (!isPlainObject(raw)) return null;
  const name = raw.name ?? raw.full_name ?? raw.business_name ?? raw.company_name;
  const company = raw.company ?? raw.business_name ?? raw.company_name ?? raw.name;
  const email = raw.email ?? raw.email_address ?? null;
  const jobTitle = raw.jobTitle ?? raw.job_title ?? raw.title ?? null;

  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof company !== "string" || !company.trim()) return null;

  return {
    name: name.trim(),
    company: company.trim(),
    email: typeof email === "string" && email.trim() ? email.trim() : null,
    jobTitle: typeof jobTitle === "string" && jobTitle.trim() ? jobTitle.trim() : null,
  };
}

/**
 * Validates the overall response envelope and extracts whatever array of
 * rows it contains, under any of the shapes Explorium's docs or sibling
 * endpoints have been seen to use (`data`, `results`, `businesses`, or a
 * bare array). An envelope that matches none of these is treated as empty
 * rather than crashing the caller — the lead-gen cascade falls back or
 * reports zero leads found, which is recoverable; an unhandled exception
 * here is not.
 */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return [];
  for (const key of ["data", "results", "businesses", "prospects"]) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  return [];
}

/**
 * Throws until EXPLORIUM_API_KEY is configured — deliberately, rather than
 * faking a response. Callers (see /api/leads/generate) only reach this
 * function once isExploriumConfigured() has already gated the call, so this
 * check is a defensive second line, not the primary guard.
 *
 * KNOWN GAP: /v2/businesses/fetch returns matching companies, not people —
 * their docs reference a separate "prospects" enrichment for contacts at
 * those companies, but the exact endpoint/payload for that second step
 * wasn't confirmed (their public docs don't show it, needs a live account
 * to find in the dashboard/API explorer). This function will need a second
 * fetch call added once that's confirmed, chaining business_id -> prospect
 * contacts, before it can return real ProspectResult rows with emails.
 *
 * Every response is validated (extractRows + coerceProspectRow) rather than
 * cast straight to ProspectResult[] — the payload shape here is unverified
 * against a live account, so a field rename or wrapper change on
 * Explorium's side degrades to "fewer/zero prospects returned" instead of
 * throwing a shape-mismatch error deep inside the lead-gen pipeline.
 */
export async function findProspects(query: ProspectQuery): Promise<ProspectResult[]> {
  if (!EXPLORIUM_API_KEY) {
    throw new Error(
      "EXPLORIUM_API_KEY is not set — sign up at explorium.ai and add the key to .env.local to enable automatic prospecting"
    );
  }

  let res: Response;
  try {
    // Confirmed against developers.explorium.ai: POST /v2/businesses/fetch,
    // auth via a plain `api_key` header (not "Authorization: Bearer"). The
    // exact filter field names still need confirming against a live account —
    // country/company_size/naics_category are the ones documented so far.
    // TODO: once EXPLORIUM_API_KEY exists, verify this payload shape actually
    // returns matches and adjust field names if the API rejects it.
    res = await fetch(`${EXPLORIUM_BASE_URL}/businesses/fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        api_key: EXPLORIUM_API_KEY,
      },
      body: JSON.stringify({
        filters: {
          country: ["us"],
          company_size: query.companySizeRange,
          naics_category: query.industries,
        },
        size: query.limit,
      }),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, TLS) — never an unhandled
    // rejection; the caller decides whether to fall back to another source.
    throw new Error(`Explorium request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Explorium API failed: ${res.status} ${text.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new Error(`Explorium returned a non-JSON response: ${(err as Error).message}`);
  }

  const rows = extractRows(payload);
  const prospects = rows.map(coerceProspectRow).filter((p): p is ProspectResult => p !== null);

  if (rows.length > 0 && prospects.length === 0) {
    // Every row failed validation — this is exactly the "payload shape
    // changed/was never confirmed" scenario the TODO above warns about.
    // Surface it as a loud, specific error rather than silently returning
    // an empty array that looks identical to "no matches found".
    throw new Error(
      `Explorium returned ${rows.length} row(s) but none matched the expected shape — the API's payload format may have changed; see src/lib/explorium.ts`
    );
  }

  return prospects;
}
