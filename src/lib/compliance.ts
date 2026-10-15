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
  /\bstop\b/i,
  /don'?t (?:contact|email) me/i,
  /do not (?:contact|email) me/i,
  /opt(?:\s|-)?out/i,
  /leave me (?:alone|be)/i,
  /stop (?:contacting|sending|messaging|calling)/i,
  /never (?:contact|email|message) me/i,
];

export function isUnsubscribeRequest(text: string): boolean {
  return UNSUBSCRIBE_PATTERNS.some((re) => re.test(text));
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
  const who = [opts.company?.trim(), opts.postalAddress?.trim()].filter(Boolean).join(" · ");
  if (who) lines.push(who);
  return [body.trimEnd(), "", "--", ...lines].join("\n");
}

/** RFC 2369 List-Unsubscribe (mailto form: it lands in the same mailbox the inbound handler already processes). */
export function unsubscribeHeaders(replyAddress: string): Record<string, string> {
  return { "List-Unsubscribe": `<mailto:${replyAddress}?subject=unsubscribe>` };
}
