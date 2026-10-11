/**
 * Pure helpers for the meeting link that goes into auto-replies.
 *
 * Why this exists: the link used to live only inside the Gemini prompt ("put this link on its own line"), so
 * the model could silently drop it and nothing noticed. The server now guarantees it.
 */

/** Appends the booking link when the drafted body does not already contain it. No link given -> body unchanged. */
export function ensureBookingLink(body: string, url: string | null | undefined): string {
  const link = url?.trim();
  if (!link) return body;
  // Compare without a trailing slash so "https://x/y" and "https://x/y/" count as the same link.
  const bare = link.replace(/\/+$/, "");
  if (body.includes(bare)) return body;
  return `${body.trimEnd()}\n\nPick a time that suits you: ${link}`;
}

/**
 * Per-lead meeting name so every tenant's prospects see THEIR company on the booking page / invite
 * (not Calendly's generic "appointment"). e.g. "Infomist – AI voice receptionist demo".
 */
export function leadMeetingEventName(company: string | null | undefined, topic: string | null | undefined): string {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const c = clean(company);
  const t = clean(topic);
  const name = c && t ? `${c} – ${t}` : c ? `${c} – Intro call` : t || "Intro call";
  return name.slice(0, 120);
}
