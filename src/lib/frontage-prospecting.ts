import type { ProspectQuery, ProspectResult } from "@/lib/explorium";

/**
 * Prospect search over the Frontage Leads MCP (a business database, filterable by
 * country / city / category). The form's location answers are real filters here, so a
 * change in country, city, industry or quantity changes what comes back.
 *
 * Tools used (schemas confirmed against the live server): list_countries,
 * list_categories(country, contains), list_cities(country, contains), search_leads(country,
 * city, category, search, has_email, limit<=100, offset). Rows: { name, category, city, country, email?, phone?, id }.
 */
export type FrontageCall = (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface FrontageQuery extends Pick<ProspectQuery, "industries" | "keywords" | "limit"> {
  /** Country names or ISO codes as typed in the form. */
  countries: string[];
  /** City names; empty means the whole country. */
  cities: string[];
  /** Free-text "places to exclude" from the form — country names/codes and/or city names mixed together. */
  excludedLocations?: string[];
}

/** Splits a free-text exclusion list into resolved country codes and leftover city-name keywords. */
export async function resolveExclusions(
  call: FrontageCall,
  excludedLocations: string[]
): Promise<{ excludedCountryCodes: Set<string>; excludedCityKeywords: string[] }> {
  if (!excludedLocations.length) return { excludedCountryCodes: new Set(), excludedCityKeywords: [] };
  const { codes, unknown } = await resolveCountryCodes(call, excludedLocations);
  return { excludedCountryCodes: new Set(codes), excludedCityKeywords: unknown.map((s) => s.trim().toLowerCase()).filter(Boolean) };
}

/** One validated search: every value is known to exist in the connector. */
export interface FrontagePlan {
  country: string;
  city: string | null;
  /** Filter sets tried in turn, e.g. [{category:"dentist"}] or [{search:"dentists"}] or [{}]. */
  filters: Record<string, unknown>[];
}

/** An unvalidated proposal (from Gemini): what convertFormToLeadsConnectorInput returns. */
export interface ProposedSearch {
  country: string;
  city: string | null;
  categories: string[];
  search: string | null;
}

interface FrontageRow {
  name?: string;
  category?: string;
  city?: string;
  country?: string;
  email?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3;

/** Form values arrive as arrays or as "a, b" strings. */
export function toList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]/) : [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

/** Country names/ISO codes -> ISO codes, using the provider's own country list. Unknown names are reported, never dropped silently. */
export async function resolveCountryCodes(call: FrontageCall, names: string[]): Promise<{ codes: string[]; unknown: string[] }> {
  const payload = await call("list_countries", {});
  const list = (payload.countries as { country: string; name: string }[] | undefined) ?? [];
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const key = n.trim().toLowerCase();
    // "UK" is a common alias; the provider's canonical code for the United Kingdom is GB.
    const wanted = key === "uk" ? "gb" : key;
    const hit = list.find((c) => c.country.toLowerCase() === wanted || c.name.toLowerCase() === wanted);
    if (hit) {
      if (!codes.includes(hit.country)) codes.push(hit.country);
    } else unknown.push(n);
  }
  return { codes, unknown };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function categoriesContaining(call: FrontageCall, country: string, contains: string): Promise<string[]> {
  const p = await call("list_categories", { country, contains });
  const cats = (p.categories as unknown[] | undefined) ?? [];
  return cats
    .map((c) => (typeof c === "string" ? c : String((c as { category?: string; slug?: string }).category ?? (c as { slug?: string }).slug ?? "")))
    .filter(Boolean);
}

/** Category slugs matching an industry phrase in one country; [] when none (caller falls back to free-text). */
async function categorySlugs(call: FrontageCall, country: string, industry: string): Promise<string[]> {
  const slug = slugify(industry);
  const words = slug.split("_").filter((w) => w.length > 2);
  for (const contains of [slug, ...words]) {
    if (!contains) continue;
    const slugs = await categoriesContaining(call, country, contains);
    if (slugs.length) return slugs.slice(0, 2);
  }
  return [];
}

const stem = (t: string) => t.slice(0, 4);

/**
 * Maps a guessed category slug (e.g. Gemini's "real_estate_agency") onto the closest category the connector
 * really has ("real_estate_agent"). Candidates come from the connector's own list via prefix searches; they are
 * scored by how many word stems they share with the guess, and only a clear match is used. Returns [] when
 * nothing is close, so the caller falls back to a keyword search instead of a wrong category.
 */
export async function closestCategories(call: FrontageCall, country: string, guess: string): Promise<string[]> {
  const tokens = slugify(guess).split("_").filter(Boolean);
  if (!tokens.length) return [];
  const queries = new Set<string>();
  for (let n = tokens.length; n >= 1; n--) queries.add(tokens.slice(0, n).join("_"));
  for (const t of tokens) if (t.length >= 4) queries.add(t);

  const candidates = new Set<string>();
  for (const q of queries) for (const c of await categoriesContaining(call, country, q)) candidates.add(c);

  const want = new Set(tokens.map(stem));
  const scored = [...candidates].map((c) => ({ c, score: c.split("_").filter((t) => want.has(stem(t))).length, extra: c.split("_").length }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  const needed = tokens.length === 1 ? 1 : 2;
  if (best < needed) return [];
  // Best overlap first; among equals prefer the fewest extra words ("real_estate_agent" over "real_estate_law_firm").
  return scored
    .filter((x) => x.score === best)
    .sort((a, b) => a.extra - b.extra || a.c.localeCompare(b.c))
    .slice(0, 2)
    .map((x) => x.c);
}

/** The connector's spelling of a city (it holds messy variants), or null when it has nothing close. */
async function canonicalCity(call: FrontageCall, country: string, city: string): Promise<string | null> {
  const p = await call("list_cities", { country, contains: city });
  const cities = ((p.cities as unknown[] | undefined) ?? []).map(String);
  return cities.find((c) => c.toLowerCase() === city.trim().toLowerCase()) ?? null;
}

/**
 * Turns a proposal into searches the connector will accept. Nothing unvalidated survives:
 * unknown countries are reported; a category kept only if the connector lists it; a city kept only
 * if the connector has that exact spelling (otherwise it becomes a free-text keyword, so a city the
 * user named is never silently dropped into "whole country").
 */
export async function validateProposals(
  call: FrontageCall,
  proposals: ProposedSearch[],
  excludedCountryCodes: Set<string> = new Set()
): Promise<{ plans: FrontagePlan[]; unknown: string[] }> {
  const plans: FrontagePlan[] = [];
  const unknown: string[] = [];
  for (const prop of proposals) {
    const { codes } = await resolveCountryCodes(call, [String(prop.country ?? "")]);
    if (!codes.length) {
      unknown.push(String(prop.country ?? ""));
      continue;
    }
    const country = codes[0];
    // The client explicitly excluded this country — drop the whole proposal rather than searching it and
    // relying on a post-filter to catch every row (the AI's proposal exists specifically to target this
    // country, so there's nothing safe to salvage from it).
    if (excludedCountryCodes.has(country)) continue;

    const validCategories: string[] = [];
    // A slug the connector does not list (the model guessed it) still names a kind of business the user
    // wants, so it is kept as a free-text keyword instead of being silently lost.
    const keywordFallbacks: string[] = [];
    for (const raw of prop.categories ?? []) {
      const slug = slugify(String(raw));
      if (!slug) continue;
      const found = await categoriesContaining(call, country, slug);
      const exact = found.find((f) => f === slug);
      if (exact) {
        if (!validCategories.includes(exact)) validCategories.push(exact);
        continue;
      }
      const close = await closestCategories(call, country, slug);
      if (close.length) {
        for (const c of close) if (!validCategories.includes(c)) validCategories.push(c);
      } else keywordFallbacks.push(slug.replace(/_/g, " "));
    }

    // A city is NEVER folded into a free-text `search` term — `search` matches a business's NAME,
    // address and website too, so "city as keyword" previously let a business named e.g. "Tony O'Brien -
    // Los Angeles Realtor" (actually located in Beverly Hills) or "...eXp of Greater Los Angeles, Inc."
    // (actually in Buena Park) match purely because the city name appeared in their NAME, not because
    // they're actually there. `canonicalCity` only checks the connector's "most common cities" shortlist,
    // so a real but less-common city can still fail it — city is always passed as the connector's own
    // `city` filter param (an exact-match field, per its own schema), canonical or not, and runPlans below
    // additionally re-verifies every returned row's actual `city` field before accepting it.
    const city = prop.city ? (await canonicalCity(call, country, prop.city)) ?? prop.city : null;

    const filters: Record<string, unknown>[] = [
      ...validCategories.map((category) => ({ category })),
      ...keywordFallbacks.map((kw) => ({ search: kw })),
    ];
    if (!filters.length) filters.push(prop.search ? { search: prop.search } : {});
    plans.push({ country, city, filters });
  }
  return { plans, unknown };
}

/** Deterministic plans straight from the form (no AI): used when the AI proposal is unavailable or unusable. */
export async function plansFromForm(
  query: FrontageQuery,
  call: FrontageCall,
  excludedCountryCodes: Set<string> = new Set()
): Promise<FrontagePlan[]> {
  if (!query.countries.length) throw new Error("Choose at least one target country");
  const { codes: allCodes, unknown } = await resolveCountryCodes(call, query.countries);
  if (!allCodes.length) throw new Error(`Unrecognised target country: ${unknown.join(", ")}`);
  const codes = allCodes.filter((c) => !excludedCountryCodes.has(c));
  if (!codes.length) throw new Error("Every target country is also in the excluded-places list");

  const plans: FrontagePlan[] = [];
  const industries = query.industries.length ? query.industries : [null];
  for (const country of codes) {
    const filters: Record<string, unknown>[] = [];
    for (const industry of industries) {
      const slugs = industry ? await categorySlugs(call, country, industry) : [];
      if (slugs.length) filters.push(...slugs.map((category) => ({ category })));
      else filters.push(industry ? { search: industry } : {});
    }
    for (const city of query.cities.length ? query.cities : [null]) plans.push({ country, city, filters });
  }
  return plans;
}

export interface RunPlansResult {
  prospects: ProspectResult[];
  /** How many raw rows the source actually returned this run (regardless of dedup) — the caller advances
   * its stored cursor by this, so the NEXT run with the same criteria starts past everything just scanned. */
  rowsScanned: number;
  /** True once every filter ran out of rows (hit a page shorter than requested) — the search is exhausted,
   * so the caller should reset its cursor to 0 instead of advancing it past the end forever. */
  exhausted: boolean;
}

/**
 * `baseOffset` shifts every filter's pagination forward by a flat amount — set from a cursor persisted per
 * (client, search criteria) so resubmitting the same Find Leads form continues from where the last search
 * left off instead of re-fetching the same top results every time (which then all get deduped away against
 * already-saved leads, looking like the search "does nothing" on a repeat run).
 */
export async function runPlans(
  plans: FrontagePlan[],
  limit: number,
  call: FrontageCall,
  baseOffset = 0,
  excludedCityKeywords: string[] = []
): Promise<RunPlansResult> {
  const seen = new Set<string>();
  const out: ProspectResult[] = [];
  let rowsScanned = 0;
  let allFiltersExhausted = true;

  outer: for (const plan of plans) {
    for (const filter of plan.filters) {
      let filterExhausted = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageSize = Math.min(PAGE_SIZE, Math.max((limit - out.length) * 2, 10));
        const payload = await call("search_leads", {
          country: plan.country,
          has_email: true,
          ...(plan.city ? { city: plan.city } : {}),
          ...filter,
          limit: pageSize,
          offset: baseOffset + page * pageSize,
        });
        const rows = (payload.leads as FrontageRow[] | undefined) ?? [];
        rowsScanned += rows.length;
        for (const r of rows) {
          // Defense in depth, regardless of how this row was found (exact city param, category, or a
          // free-text keyword search): a requested city must match the row's OWN city field exactly, not
          // just appear somewhere in its name. "Tony O'Brien - Los Angeles Realtor" (actually Beverly
          // Hills) or "...eXp of Greater Los Angeles, Inc." (actually Buena Park) are real rows the source
          // itself returns for a free-text "Los Angeles" search — never accept one on a name match alone.
          if (plan.city && r.city?.trim().toLowerCase() !== plan.city.trim().toLowerCase()) continue;
          // "Places to exclude" is enforced against every row's own city field, not just trusted to the AI
          // prompt that built this plan — a country-wide scan (no plan.city) would otherwise have no
          // exclusion check at all for a specific excluded city within that country.
          const rowCity = r.city?.trim().toLowerCase() ?? "";
          if (rowCity && excludedCityKeywords.some((kw) => rowCity.includes(kw))) continue;
          const email = r.email?.trim().toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          const name = (r.name ?? "").trim();
          out.push({ name, email, company: name, jobTitle: null });
          if (out.length >= limit) break outer;
        }
        if (rows.length < pageSize) {
          filterExhausted = true;
          break;
        }
      }
      if (!filterExhausted) allFiltersExhausted = false;
    }
  }
  return { prospects: out, rowsScanned, exhausted: allFiltersExhausted };
}

/**
 * Finds prospects. `proposals` (Gemini's conversion of the form into connector inputs) is used when it
 * validates; otherwise the plan is built deterministically from the form's own answers.
 */
export async function findProspectsViaFrontageLeads(
  query: FrontageQuery,
  call: FrontageCall,
  proposals?: ProposedSearch[],
  baseOffset = 0
): Promise<RunPlansResult> {
  const { excludedCountryCodes, excludedCityKeywords } = await resolveExclusions(call, query.excludedLocations ?? []);

  let plans: FrontagePlan[] = [];
  if (proposals?.length) {
    // The AI may only narrow, never widen: drop any proposed country the form did not name.
    const allowed = new Set((await resolveCountryCodes(call, query.countries)).codes);
    const inScope: ProposedSearch[] = [];
    for (const p of proposals) {
      const { codes } = await resolveCountryCodes(call, [String(p.country ?? "")]);
      if (codes.length && allowed.has(codes[0])) inScope.push(p);
    }
    plans = (await validateProposals(call, inScope, excludedCountryCodes)).plans;
  }
  if (!plans.length) plans = await plansFromForm(query, call, excludedCountryCodes);
  return runPlans(plans, query.limit, call, baseOffset, excludedCityKeywords);
}
