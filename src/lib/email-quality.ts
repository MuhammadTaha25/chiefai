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

/**
 * Weighted spam patterns, in the spirit of SpamAssassin / classic ML spam filters: one weak signal is fine, several
 * add up. Each hit adds its weight once; a draft at SPAM_SCORE_LIMIT or above is treated as spammy and not sent.
 * (The hard-block SPAM_PHRASES above fail on their own regardless of score.)
 */
export const SPAM_SCORE_LIMIT = 3;
const SPAM_PATTERNS: { re: RegExp; weight: number; label: string }[] = [
  // pressure / urgency
  { re: /\b(don'?t miss|last chance|hurry|expires?|deadline|only \d+ (left|spots?)|while (supplies|stocks) last|today only|offer ends)\b/i, weight: 2, label: "pressure wording" },
  { re: /\b(act (fast|today)|apply now|order now|call now|sign up now|get started now|reply now)\b/i, weight: 2, label: "call-now wording" },
  // money / offers
  { re: /(\$\s?\d|\b\d+\s?(usd|dollars)\b|\b\d+\s?% off\b|\bdiscount|\bcheap(est)?\b|\blowest price|\bsave big|\bbargain|\bprofit|\bincome\b|\bpassive income|\bcredit card|\bloan\b)/i, weight: 2, label: "money wording" },
  { re: /\b(exclusive (deal|offer)|special (offer|promotion|deal)|incredible|amazing (offer|deal)|unbeatable|best price|no (cost|fee|strings|catch)|no credit check)\b/i, weight: 2, label: "offer hype" },
  // hype claims
  { re: /\b(game[- ]?chang(er|ing)|revolutionary|skyrocket|explode your|10x|proven (system|method)|miracle|breakthrough|guaranteed results?|best[- ]in[- ]class|world[- ]class|cutting[- ]edge)\b/i, weight: 1, label: "hype claim" },
  // classic cold-email tells
  { re: /\b(i hope this (email|message) finds you|dear (sir|madam|friend|customer)|to whom it may concern|quick favou?r|just checking in|just following up|per my last)\b/i, weight: 1, label: "cold-email cliche" },
  { re: /\b(synergy|touch base|circle back|low[- ]hanging fruit|leverage|win[- ]win)\b/i, weight: 1, label: "buzzword" },
  // deceptive framing
  { re: /\b(you('ve| have)? (won|been selected|are a winner)|this is not spam|not a scam|as seen on|you are (pre[- ]?)?approved|final notice)\b/i, weight: 3, label: "deceptive framing" },
  // link shorteners / tracking-ish
  { re: /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|rb\.gy|cutt\.ly)\//i, weight: 3, label: "link shortener" },
  // obfuscation: f.r.e.e, fr33, spaced letters
  { re: /\b(?:[a-z]\.){3,}[a-z]\b|\b(fr33|v1agra|cl1ck|0ffer|g00d)\b|\b(?:[a-z] ){5,}[a-z]\b/i, weight: 3, label: "obfuscated text" },
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

/** Weighted spam score of a draft (subject counts double for the signals that matter most there). */
export function spamScore(d: Draft): { total: number; hits: string[] } {
  const subject = d.subject.trim();
  const body = d.body.trim();
  const text = `${subject}\n${body}`;
  let total = 0;
  const hits: string[] = [];
  const add = (w: number, label: string) => { total += w; hits.push(label); };
  for (const p of SPAM_PATTERNS) if (p.re.test(text)) add(p.weight, p.label);
  // Subject-line tells.
  if (/\$|%/.test(subject)) add(1, "$ or % in subject");
  if (subject && subject === subject.toUpperCase() && /[A-Z]{4,}/.test(subject)) add(2, "all-caps subject");
  if (/\b(re|fwd?):/i.test(subject)) add(2, "fake reply subject");
  if (/\b(open|read|see) (this|inside)\b|\bnew message\b|\bimportant\b|\bfinal\b/i.test(subject)) add(1, "clickbait subject");
  // Shouting and punctuation in the body.
  const shouted = (body.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  if (shouted >= 2) add(1, "capitalised words");
  if (/[?!]{2,}/.test(text)) add(1, "repeated punctuation");
  // Density: a high share of sales words relative to length reads as a promotion, not a note.
  const sales = (text.match(/\b(offer|deal|sale|promo|promotion|discount|bonus|prize|reward|special|exclusive|guarantee\w*|instant(ly)?|amazing|incredible|unlimited)\b/gi) ?? []).length;
  const words = Math.max(1, wordCount(body));
  if (sales >= 2 && sales / words > 0.06) add(2, "sales-word density");
  // Several links in one note.
  if ((body.match(/\bhttps?:\/\/\S+/gi) ?? []).length >= 2) add(2, "multiple links");
  return { total, hits };
}

/** Share of this text's 3-word runs that already appear in earlier emails (0-1). Near-copies read as templated mail. */
export function repeatedWordingShare(text: string, earlier: string[]): number {
  const grams = (t: string) => {
    const w = t.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(" "));
    return out;
  };
  const mine = grams(text);
  if (!mine.size) return 0;
  const seen = new Set<string>();
  for (const e of earlier) for (const g of grams(e)) seen.add(g);
  let hit = 0;
  for (const g of mine) if (seen.has(g)) hit++;
  return hit / mine.size;
}

/** Empty list = safe to send. */
export function lintOutreachEmail(d: Draft, opts: { firstTouch?: boolean; earlierBodies?: string[] } = { firstTouch: true }): string[] {
  const issues: string[] = [];
  const subject = d.subject.trim();
  const body = d.body.trim();
  const text = `${subject}\n${body}`.toLowerCase();

  if (!subject) issues.push("empty subject");
  if (subject.length > 50) issues.push("subject longer than 50 characters");
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
  // Invented proof: statistics and "clients report" style claims the sender never supplied.
  if (/\b\d+(\.\d+)?\s*\+?\s*(%|percent\b|hours?\s+(per|a|each|every)\b|x\s+(more|faster|better))/i.test(body)) issues.push("invented statistic");
  if (/\b(clients|customers|users|businesses)\s+(report|say|tell us|see|have seen)\b/i.test(body)) issues.push("invented customer claim");
  if ((body.match(/!/g) ?? []).length > 1) issues.push("more than one exclamation mark");
  if (opts.earlierBodies?.length && repeatedWordingShare(body, opts.earlierBodies) > 0.35) issues.push("repeats wording from earlier emails");
  const score = spamScore(d);
  if (score.total >= SPAM_SCORE_LIMIT) issues.push(`spam score ${score.total} (limit ${SPAM_SCORE_LIMIT}): ${score.hits.join(", ")}`);
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.3) issues.push("too much capitalisation");
  return issues;
}
