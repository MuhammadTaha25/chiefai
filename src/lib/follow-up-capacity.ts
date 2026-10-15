/**
 * Pure helpers for keeping room in each mailbox for FOLLOW-UPS. A follow-up always goes out from the mailbox
 * that sent the lead's first email and never switches, so if new first emails use up that mailbox's daily limit
 * first, the follow-ups pinned to it have to wait a day. First emails therefore only get what is left after the
 * follow-ups still due today. Pure on purpose (no imports) so it can be tested without the app's path aliases.
 */

/** Which mailbox sent each lead's FIRST email (rows must be ordered oldest first). */
export function originalMailboxByLead(rows: { lead_id: string; mailbox_id: string | null }[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const r of rows) if (r.mailbox_id && !first.has(r.lead_id)) first.set(r.lead_id, r.mailbox_id);
  return first;
}

/** How many of the due leads are pinned to `mailboxId` (their first email came from it). */
export function followUpsPinnedTo(dueLeadIds: string[], firstMailbox: Map<string, string>, mailboxId: string): number {
  let n = 0;
  for (const id of dueLeadIds) if (firstMailbox.get(id) === mailboxId) n++;
  return n;
}

/**
 * Whether a NEW first email may take one of today's slots. `sentToday` counts every email already sent
 * (first emails and follow-ups); `dueFollowUps` are the follow-ups still due today that must keep a slot.
 */
export function newEmailFits(sentToday: number, dueFollowUps: number, limit: number): boolean {
  return sentToday + dueFollowUps < limit;
}
