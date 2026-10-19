/**
 * Deterministic, non-AI detection of an explicit unsubscribe/stop request.
 * This is intentionally NOT delegated to Gemini — an LLM's sentiment
 * classification can be wrong or inconsistent, and a missed unsubscribe
 * means continuing to email someone who explicitly asked to be removed
 * (a compliance problem, not just a UX one). A plain keyword check is the
 * safest mechanism here precisely because it's predictable and auditable.
 */
const UNSUBSCRIBE_PATTERNS = [
  /unsubscribe/i,
  /remove me/i,
  /take me off/i,
  /stop email(?:ing)?/i,
  // A bare "stop" is an opt-out, but not "stop by", "stop in", "don't stop" or "never stop" (a friendly or interested reply).
  /\bstop\b(?!\s+(?:by|in|over|at|off|into|the|worrying)\b)/i,
  /don'?t (?:contact|email) me/i,
  /do not (?:contact|email) me/i,
  /opt(?:\s|-)?out/i,
  /leave me (?:alone|be)/i,
  /stop (?:contacting|sending|messaging|calling)/i,
  /never (?:contact|email|message) me/i,
];

export function isUnsubscribeRequest(text: string): boolean {
  // "don't stop sending me updates" asks for MORE mail: drop the negated "stop" before looking for opt-out words.
  const t = text.replace(/\b(?:don'?t|do not|not|never|won'?t|cannot|can'?t)\s+stop\b/gi, " ");
  return UNSUBSCRIBE_PATTERNS.some((re) => re.test(t));
}

/** Static, non-AI-generated confirmation — a compliance-sensitive message should never depend on an LLM call succeeding or behaving. */
export function unsubscribeConfirmation(senderCompany: string) {
  return {
    subject: "You've been removed",
    body: `You won't receive any further emails from ${senderCompany}. Sorry for the inconvenience, and thanks for letting us know.`,
  };
}

/**
 * True for machine-generated mail that must NEVER be auto-answered: out-of-office /
 * vacation replies, bounces, list mail and no-reply senders. Auto-replying to these
 * creates auto-responder loops (two robots answering each other forever).
 * Based on RFC 3834 (Auto-Submitted) plus the common de-facto headers. Headers come
 * from Mailgun's `message-headers` field: a JSON array of [name, value] pairs.
 */
export function isAutomatedMessage(sender: string, messageHeadersJson: string | null | undefined): boolean {
  const addr = (sender.match(/<(.+)>/)?.[1] ?? sender).trim().toLowerCase();
  const local = addr.split("@")[0] ?? "";
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|noreply\+.*|notifications?)$/.test(local)) return true;
  let pairs: unknown = [];
  try {
    pairs = messageHeadersJson ? JSON.parse(messageHeadersJson) : [];
  } catch {
    pairs = [];
  }
  if (!Array.isArray(pairs)) return false;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
    const name = pair[0].toLowerCase();
    const value = String(pair[1] ?? "").trim().toLowerCase();
    if (name === "auto-submitted" && value !== "no") return true;
    if (name === "precedence" && ["bulk", "junk", "list", "auto_reply", "auto-reply"].includes(value)) return true;
    if (name === "x-autoreply" || name === "x-autorespond" || name === "x-auto-response-suppress") return true;
    if (name === "list-id" || name === "list-unsubscribe") return true;
  }
  return false;
}

/**
 * Cold-outreach compliance footer: who we are, how to stop, and (when the owner has set one) the sender's
 * postal address. Appended server-side at send time; never to auto-replies (those answer the prospect).
 * The opt-out is a reply keyword the inbound handler already detects deterministically (isUnsubscribeRequest).
 */
export function withUnsubscribeFooter(body: string, opts: { company: string | null | undefined; postalAddress?: string | null }): string {
  const lines = ['Not interested? Reply "STOP" and we will not email you again.'];
  // The company name is already in the sender's signature, so it is repeated here only next to a postal address.
  const address = opts.postalAddress?.trim();
  if (address) lines.push([opts.company?.trim(), address].filter(Boolean).join(" · "));
  return [body.trimEnd(), "", "--", ...lines].join("\n");
}

/** RFC 2369 List-Unsubscribe (mailto form: it lands in the same mailbox the inbound handler already processes). */
export function unsubscribeHeaders(replyAddress: string): Record<string, string> {
  return { "List-Unsubscribe": `<mailto:${replyAddress}?subject=unsubscribe>` };
}
