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
 * Throws until EXPLORIUM_API_KEY is configured — deliberately, rather than
 * faking a response.
 *
 * KNOWN GAP: /v2/businesses/fetch returns matching companies, not people —
 * their docs reference a separate "prospects" enrichment for contacts at
 * those companies, but the exact endpoint/payload for that second step
 * wasn't confirmed (their public docs don't show it, needs a live account
 * to find in the dashboard/API explorer). This function will need a second
 * fetch call added once that's confirmed, chaining business_id -> prospect
 * contacts, before it can return real ProspectResult rows with emails.
 */
export async function findProspects(query: ProspectQuery): Promise<ProspectResult[]> {
  if (!EXPLORIUM_API_KEY) {
    throw new Error(
      "EXPLORIUM_API_KEY is not set — sign up at explorium.ai and add the key to .env.local to enable automatic prospecting"
    );
  }

  // Confirmed against developers.explorium.ai: POST /v2/businesses/fetch,
  // auth via a plain `api_key` header (not "Authorization: Bearer"). The
  // exact filter field names still need confirming against a live account —
  // country/company_size/naics_category are the ones documented so far.
  // TODO: once EXPLORIUM_API_KEY exists, verify this payload shape actually
  // returns matches and adjust field names if the API rejects it.
  const res = await fetch(`${EXPLORIUM_BASE_URL}/businesses/fetch`, {
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Explorium API failed: ${res.status} ${text}`);
  }

  return res.json();
}
