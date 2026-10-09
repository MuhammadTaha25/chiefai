/**
 * Pure classifier for the inbound Mailgun webhook's recipient->mailbox
 * lookup. Extracted so the "ambiguous match" decision (Final Regression
 * Audit, 2026-10-09 — see src/app/api/webhooks/mailgun/route.ts) is
 * independently testable without a real Supabase query.
 *
 * `mailboxes` is only unique per (client_id, address), not per address
 * alone, so a lookup by address can legitimately return 2+ rows (a
 * cross-tenant address collision, most likely pre-dating the domain
 * ownership gate). This must never be silently treated the same as "no
 * match" — the caller needs to know which of the three happened.
 */
export type MailboxMatch<T> = { kind: "none" } | { kind: "single"; row: T } | { kind: "ambiguous"; rows: T[] };

export function classifyMailboxMatch<T>(rows: T[]): MailboxMatch<T> {
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "single", row: rows[0] };
  return { kind: "ambiguous", rows };
}
