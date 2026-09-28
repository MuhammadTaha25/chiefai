import type { SupabaseClient } from "@supabase/supabase-js";

export const normEmail = (e: string | null | undefined) => e?.trim().toLowerCase() ?? "";

/**
 * Removes prospects this client already has (case-insensitively) and repeats
 * inside the batch. Prospects without an email are kept: there is nothing to
 * dedupe on and nothing to send to. `existingEmails` may be in any case.
 */
export function dedupeProspects<T extends { email?: string | null }>(prospects: T[], existingEmails: Iterable<string | null | undefined>): T[] {
  const seen = new Set<string>();
  for (const e of existingEmails) if (normEmail(e)) seen.add(normEmail(e));
  return prospects.filter((p) => {
    const e = normEmail(p.email);
    if (!e) return true;
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
}

/**
 * Every existing lead email for this client (lower-cased), for the given
 * candidates. Looks them up case-insensitively so mixed-case rows created
 * before the unique (client_id, lower(email)) index are still found.
 */
export async function existingLeadEmails(admin: SupabaseClient, clientId: string, candidates: string[]): Promise<string[]> {
  const wanted = new Set(candidates.map(normEmail).filter(Boolean));
  if (!wanted.size) return [];
  const found: string[] = [];
  // Filter server-side per candidate with ilike (no wildcard characters are
  // escaped away: '%' and '_' in an email are neutralised below).
  for (const email of wanted) {
    const safe = email.replace(/[%_\\]/g, (c) => "\\" + c);
    const { data } = await admin.from("leads").select("email").eq("client_id", clientId).ilike("email", safe).limit(1);
    if (data?.length) found.push(normEmail(data[0].email));
  }
  return found;
}
