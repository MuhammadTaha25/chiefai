/**
 * Server-side, deterministic check for whether a client's business profile
 * has the minimum information automation (DM/comment replies, content
 * generation) needs to actually be business-specific instead of generic.
 * Never trust a frontend "I'm done" flag — re-derive this from the row.
 */

interface ClientRow {
  company_name?: string | null;
}

interface ProfileRow {
  niche?: string | null;
  business_description?: string | null;
  services?: string | null;
  target_audience?: string[] | null;
  tone_of_voice?: string[] | null;
}

export function isBusinessProfileComplete(client: ClientRow | null, profile: ProfileRow | null): boolean {
  if (!client || !profile) return false;
  return Boolean(
    client.company_name?.trim() &&
      profile.niche?.trim() &&
      profile.business_description?.trim() &&
      profile.services?.trim() &&
      profile.target_audience?.length &&
      profile.tone_of_voice?.length
  );
}

export const REQUIRED_BUSINESS_PROFILE_FIELDS = [
  "company_name",
  "niche",
  "business_description",
  "services",
  "target_audience",
  "tone_of_voice",
] as const;

const cap = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Products/services from the form: trimmed, length-capped, at most 30, nameless rows dropped. */
export function sanitizeProducts(v: unknown): { name: string; description?: string; benefit?: string; price?: string; url?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { name: string; description?: string; benefit?: string; price?: string; url?: string }[] = [];
  for (const raw of v.slice(0, 30)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = cap(r.name, 120);
    if (!name) continue;
    const url = cap(r.url, 300);
    out.push({
      name,
      ...(cap(r.description, 600) ? { description: cap(r.description, 600) } : {}),
      ...(cap(r.benefit, 300) ? { benefit: cap(r.benefit, 300) } : {}),
      ...(cap(r.price, 80) ? { price: cap(r.price, 80) } : {}),
      // Only http(s) links are ever shown to customers.
      ...(/^https?:\/\//i.test(url) ? { url } : {}),
    });
  }
  return out;
}

/**
 * The legacy free-text `services` column is still read by the voice agent,
 * ads and email flows, so it is derived from the structured products instead
 * of being asked for twice.
 */
export function servicesText(products: { name: string; description?: string }[]): string {
  return products.map((p) => (p.description ? `${p.name}: ${p.description}` : p.name)).join("\n");
}
