/**
 * Deterministic deliverability checks for cold outreach. AI drafts are cleaned and linted before send, so a
 * spammy draft is fixed or redrafted instead of damaging the mailbox's reputation.
 */
export interface Draft {
  subject: string;
  body: string;
}

const SPAM_PHRASES = [
  "free",
  "guarantee",
  "guaranteed",
  "act now",
  "limited time",
  "click here",
  "buy now",
  "100%",
  "risk-free",
  "no obligation",
  "winner",
  "congratulations",
  "cash",
  "earn money",
  "make money",
  "urgent",
  "once in a lifetime",
  "double your",
  "$$$",
];

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Removes markdown, fake reply prefixes, shouting and exclamation marks. Never adds content. */
export function cleanOutreachEmail(d: Draft): Draft {
  let subject = d.subject
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "")
    .replace(/[*_`#]/g, "")
    .replace(/!+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Shouting: "GROW YOUR BUSINESS" -> "Grow your business"
  const words = subject.split(" ");
  if (words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length >= 2) {
    subject = subject.charAt(0).toUpperCase() + subject.slice(1).toLowerCase();
  }
  const body = d.body
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[ \t]*[*-][ \t]+/gm, "- ")
    .replace(/!{2,}/g, "!")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { subject, body };
}

/** Empty list = safe to send. */
export function lintOutreachEmail(d: Draft, opts: { firstTouch?: boolean } = { firstTouch: true }): string[] {
  const issues: string[] = [];
  const subject = d.subject.trim();
  const body = d.body.trim();
  const text = `${subject}\n${body}`.toLowerCase();

  if (!subject) issues.push("empty subject");
  if (subject.length > 60) issues.push("subject longer than 60 characters");
  if (/[!?]{2,}/.test(subject) || subject.includes("!")) issues.push("subject contains exclamation marks");
  if (/^(re|fwd?|fw)\s*:/i.test(subject)) issues.push("subject fakes a reply/forward");
  if (/\p{Extended_Pictographic}/u.test(text)) issues.push("contains emoji");

  const wc = wordCount(body);
  if (wc < 25) issues.push("body too short to be a real email");
  if (opts.firstTouch !== false && wc > 150) issues.push("body longer than 150 words");

  for (const phrase of SPAM_PHRASES) {
    const re = new RegExp(`(^|[^a-z])${phrase.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(text)) issues.push(`spam trigger: "${phrase}"`);
  }
  if (opts.firstTouch !== false && URL_RE.test(body)) issues.push("link in first email");
  if ((body.match(/!/g) ?? []).length > 1) issues.push("more than one exclamation mark");
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.3) issues.push("too much capitalisation");
  return issues;
}
