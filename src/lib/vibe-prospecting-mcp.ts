import {
  McpOAuthProvider,
  callMcpTool,
  getRedirectUriFor,
  isMcpConnected,
  noCacheFetch,
  runMcpAuthFlow as runMcpAuthFlowRaw,
  type McpServiceConfig,
} from "@/lib/mcp-oauth-connection";
import type { ProspectQuery, ProspectResult } from "@/lib/explorium";

/**
 * "Vibe Prospecting" — Explorium's MCP server (vibeprospecting.explorium.ai/mcp),
 * connected once with the account owner's own Explorium credentials (RFC
 * 7591 dynamic client registration + OAuth 2.1 + PKCE), same pattern as
 * Frontage Leads (src/lib/leads-mcp.ts). One connection, shared across every
 * client's prospecting requests — uses the same leads_mcp_connection table,
 * under connection id "vibe_prospecting" (insert that row per
 * supabase/add_leads_mcp_connection_table.sql before connecting).
 *
 * Two ways to authorize the same stored connection:
 * - Settings page "Connect Vibe Prospecting" button -> /api/vibe-prospecting/connect
 *   -> /api/vibe-prospecting/callback (browser OAuth redirect).
 * - scripts/authorize-vibe-prospecting.ts (a one-time local-server CLI flow,
 *   for when there's no browser session handy) — both write to the same DB
 *   row, so whichever one authorizes first is enough.
 */
export const VIBE_PROSPECTING_MCP_CONFIG: McpServiceConfig = {
  connectionId: "vibe_prospecting",
  mcpUrl: "https://vibeprospecting.explorium.ai/mcp",
  serviceLabel: "Vibe Prospecting",
  redirectEnvVar: "VIBE_PROSPECTING_REDIRECT_URI",
  redirectPath: "/api/vibe-prospecting/callback",
};

export class VibeProspectingMcpOAuthProvider extends McpOAuthProvider {
  constructor(redirectUri: string) {
    super(VIBE_PROSPECTING_MCP_CONFIG, redirectUri);
  }
}

/**
 * No-arg variant for scripts/authorize-vibe-prospecting.ts, which runs
 * outside any HTTP request (no `origin` to derive a redirect URI from) — it
 * sets VIBE_PROSPECTING_REDIRECT_URI itself before importing this module.
 */
/**
 * Public origin used for the OAuth redirect. Production MUST configure PUBLIC_APP_URL;
 * it never silently falls back to localhost (a dev-only convenience).
 */
function appOrigin(): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_APP_URL is not configured; it is required in production for the OAuth redirect");
  }
  return "http://localhost:3000";
}

export class SupabaseOAuthClientProvider extends VibeProspectingMcpOAuthProvider {
  constructor() {
    super(getRedirectUri(appOrigin()));
  }
}

export function getRedirectUri(origin: string) {
  return getRedirectUriFor(VIBE_PROSPECTING_MCP_CONFIG, origin);
}

export function isVibeProspectingConnected() {
  return isMcpConnected(VIBE_PROSPECTING_MCP_CONFIG);
}

/** Alias used by /api/leads/generate — same check, same connection. */
export const isVibeProspectingAuthorized = isVibeProspectingConnected;

export function callVibeProspectingTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  redirectUri: string
) {
  return callMcpTool<T>(VIBE_PROSPECTING_MCP_CONFIG, toolName, args, redirectUri);
}

interface McpToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Every Vibe Prospecting tool response carries its parsed payload in
 * `structuredContent` (confirmed against a live call — see the "Leads"
 * search test earlier in this integration), with `content[0].text` as a
 * JSON-stringified duplicate. Prefer the structured one; fall back to
 * parsing text so a subtly different response shape doesn't just come back
 * as `undefined`.
 */
function extractPayload(result: McpToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through
    }
  }
  throw new Error("Vibe Prospecting tool response had no structuredContent or parseable text payload");
}

async function call(toolName: string, args: Record<string, unknown>, redirectUri: string) {
  const result = await callVibeProspectingTool<McpToolResult>(toolName, args, redirectUri);
  return extractPayload(result);
}

/**
 * Runs autocomplete for a single filter concept (required by Explorium
 * before using linkedin_category/job_title/etc. in fetch-entities — passing
 * raw user text for these fields is rejected/ignored) and returns the
 * standardized values to filter on.
 */
async function autocompleteValues(
  field: string,
  query: string,
  sessionId: string | undefined,
  reasoning: string,
  redirectUri: string
): Promise<{ values: string[]; sessionId: string }> {
  const payload = await call(
    "autocomplete",
    { field, query, tool_reasoning: reasoning, ...(sessionId ? { session_id: sessionId } : {}) },
    redirectUri
  );
  // Confirmed against a live call: the array is `data`, items are
  // {query, label, value} — not `values`/`results`/`suggestions`.
  const values = (payload.data ?? payload.values ?? payload.results ?? payload.suggestions) as
    | (string | { value: string })[]
    | undefined;
  const normalized = (values ?? []).map((v) => (typeof v === "string" ? v : v.value)).filter(Boolean);
  const returnedSessionId = (payload.session_id as string | undefined) ?? sessionId;
  if (!returnedSessionId) throw new Error(`Vibe Prospecting autocomplete("${field}") did not return a session_id`);
  return { values: normalized, sessionId: returnedSessionId };
}

/**
 * Real implementation against the connected Vibe Prospecting (Explorium)
 * MCP session — fetch-entities (prospects) -> enrich-prospects (contacts,
 * for emails) -> show-sample (returns the actual rows).
 *
 * VERIFIED against a live call (2026-09-15, session
 * session_55_slow_gerbils_obnoxiously_hid): real prospects with real,
 * deliverable-looking emails came back end-to-end (e.g.
 * vaibhav@careerflow.ai, contact_professional_email_status "valid"). Field
 * names below are the actual response shape, not the input-schema guess:
 * - fetch-entities preview rows: nested under `preview.preview_data`,
 *   fields prefixed `prospect_*` (prospect_full_name, prospect_company_name,
 *   prospect_job_title).
 * - show-sample rows: top-level `preview_data` (NOT nested under `preview`),
 *   plus the enrichment's own `contact_professional_email` field.
 * - Cost is NOT a flat 5 credits as show-sample's own description implies —
 *   it's per-enrichment (2 credits/result for email in this test, i.e. up to
 *   ~2 * query.limit credits, scaled down here via `number_of_results`).
 */
export async function findProspectsViaVibeProspecting(query: ProspectQuery): Promise<ProspectResult[]> {
  const redirectUri = getRedirectUri(appOrigin());
  const reasoning = `Find prospects: industries=${query.industries.join(",")}; company size=${query.companySizeRange}; job titles=${query.jobTitles.join(",")}; keywords=${query.keywords.join(",")}`.slice(
    0,
    2000
  );

  let sessionId: string | undefined;

  // 1. Standardize the industry filter (mandatory before using it below).
  let linkedinCategoryValues: string[] = [];
  if (query.industries[0]) {
    const result = await autocompleteValues("linkedin_category", query.industries[0], sessionId, reasoning, redirectUri);
    linkedinCategoryValues = result.values;
    sessionId = result.sessionId;
  }

  // 2. Standardize job titles, if any were requested (also mandatory before use).
  let jobTitleValues: string[] = [];
  if (query.jobTitles[0]) {
    const result = await autocompleteValues("job_title", query.jobTitles[0], sessionId, reasoning, redirectUri);
    jobTitleValues = result.values;
    sessionId = result.sessionId;
  }

  // 3. Find matching prospects.
  const fetchPayload = await call(
    "fetch-entities",
    {
      entity_type: "prospects",
      session_id: sessionId,
      tool_reasoning: reasoning,
      // Cap upstream instead of over-fetching then slicing client-side —
      // this is what keeps the enrichment/show-sample credit cost
      // proportional to what we actually need (confirmed: cost scales with
      // rowCount, ~2 credits/result for email enrichment).
      number_of_results: query.limit,
      filters: {
        ...(linkedinCategoryValues.length ? { linkedin_category: { values: linkedinCategoryValues } } : {}),
        ...(jobTitleValues.length ? { job_title: { values: jobTitleValues } } : {}),
        ...(query.companySizeRange ? { company_size: { values: [query.companySizeRange] } } : {}),
        has_contact_details: { value: "email" },
      },
    },
    redirectUri
  );

  sessionId = (fetchPayload.session_id as string | undefined) ?? sessionId;
  const fetchTableName = fetchPayload.table_name as string | undefined;
  if (!sessionId || !fetchTableName) {
    throw new Error(`Vibe Prospecting fetch-entities returned no session_id/table_name: ${JSON.stringify(fetchPayload)}`);
  }

  // 4. Enrich with real contact emails — fetch-entities only returns
  // discovery fields, never the email/phone values themselves.
  const enrichPayload = await call(
    "enrich-prospects",
    {
      table_name: fetchTableName,
      enrichments: ["enrich-prospects-contacts"],
      parameters: { contact_types: ["email"] },
      session_id: sessionId,
    },
    redirectUri
  );
  const enrichedTableName = (enrichPayload.table_name as string | undefined) ?? fetchTableName;

  // 5. Pull the actual rows. Flat 5-credit charge, confirmed in the tool's
  // own description — this is where real data (not a preview) comes back.
  const samplePayload = await call(
    "show-sample",
    {
      table_name: enrichedTableName,
      session_id: sessionId,
      tool_reasoning: reasoning,
      preview_table_columns: ["prospect_full_name", "contact_professional_email", "prospect_company_name", "prospect_job_title"],
    },
    redirectUri
  );

  // show-sample nests rows differently than fetch-entities — top-level
  // `preview_data`, not `preview.preview_data`. Check both since Explorium's
  // own tools aren't fully consistent about this across endpoints.
  const rows =
    (samplePayload.preview_data as Record<string, unknown>[] | undefined) ??
    (samplePayload.preview as { preview_data?: Record<string, unknown>[] } | undefined)?.preview_data ??
    (samplePayload.rows as Record<string, unknown>[] | undefined) ??
    (samplePayload.data as Record<string, unknown>[] | undefined);

  if (!Array.isArray(rows)) {
    throw new Error(`Vibe Prospecting show-sample returned no recognizable row data: ${JSON.stringify(samplePayload)}`);
  }

  return rows.slice(0, query.limit).map((row) => ({
    name: (row.prospect_full_name as string) || (row.full_name as string) || (row.name as string) || "",
    email: (row.contact_professional_email as string) || (row.professional_email as string) || (row.email as string) || null,
    company: (row.prospect_company_name as string) || (row.company_name as string) || (row.company as string) || "",
    jobTitle: (row.prospect_job_title as string) || (row.job_title as string) || null,
  }));
}

export function runMcpAuthFlow(
  provider: Parameters<typeof runMcpAuthFlowRaw>[0],
  options: Parameters<typeof runMcpAuthFlowRaw>[1]
) {
  return runMcpAuthFlowRaw(provider, { ...options, fetchFn: noCacheFetch });
}
