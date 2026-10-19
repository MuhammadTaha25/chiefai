/** Domains carrying more mailboxes than the usual safe maximum (all mailboxes on a domain share one reputation). */
export const SAFE_MAILBOXES_PER_DOMAIN = 3;

export function crowdedDomains(addresses: string[]): [string, number][] {
  const perDomain = new Map<string, number>();
  for (const a of addresses) {
    const d = a.split("@").pop()?.toLowerCase() ?? "";
    perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
  }
  return [...perDomain.entries()].filter(([, n]) => n > SAFE_MAILBOXES_PER_DOMAIN);
}
