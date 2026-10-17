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

const SIGNOFF_WORD = /^(best|best regards|kind regards|regards|warm regards|thanks|thank you|many thanks|cheers|sincerely|talk soon|all the best)[,.!]?$/i;
const GREETING_LINE = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^\n]{0,60}$/i;

/**
 * Greeting and sign-off are added by the system, never trusted to the model, so every email of a client carries that
 * client's own sender name and addresses the right lead. Any greeting / sign-off the model wrote anyway is removed first.
 * `greetingName` is the lead's first name, or null for a business lead ("Hi there,").
 */
export function applyGreetingAndSignoff(d: Draft, opts: { greetingName: string | null; senderName: string }): Draft {
  let paras = d.body.replace(/\r/g, "").trim().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // Leading greeting paragraph ("Hi Sam,") written by the model.
  if (paras.length > 1 && !/\n/.test(paras[0]) && GREETING_LINE.test(paras[0]) && /[,:]?$/.test(paras[0]) && !/[.?!]$/.test(paras[0])) paras.shift();
  // Trailing sign-off ("Best,\nTest Co" or a lone name/company line).
  const last = paras[paras.length - 1] ?? "";
  const lastLines = last.split("\n").map((l) => l.trim()).filter(Boolean);
  if (paras.length > 1 && lastLines.length && SIGNOFF_WORD.test(lastLines[0])) paras.pop();
  else if (paras.length > 1 && lastLines.length <= 3 && last.split(/\s+/).length <= 6 && !/[.?!]/.test(last)) paras.pop();
  const name = (opts.greetingName ?? "").trim().split(/\s+/)[0];
  const sender = opts.senderName.replace(/["<>\r\n]/g, "").trim() || "Team";
  return { subject: d.subject, body: [`Hi ${name || "there"},`, ...paras, `Best,\n${sender}`].join("\n\n") };
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

const SUBJECT_FILLER = new Set(["quick", "question", "idea", "about", "note", "thought", "regarding", "your", "with", "from", "this", "that", "have", "for", "the", "and", "you", "hello", "just"]);
/** True when the subject shares at least one meaningful word with the body (so it is not clickbait). */
export function subjectMatchesBody(subject: string, body: string): boolean {
  const words = subject.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !SUBJECT_FILLER.has(w));
  if (!words.length) return true; // nothing to compare, nothing misleading
  const b = body.toLowerCase();
  return words.some((w) => b.includes(w.length > 5 ? w.slice(0, w.length - 1) : w));
}

/** Empty list = safe to send. */
/**
 * Industry families used to stop an email being about the wrong trade (e.g. a food email to a realtor).
 * Matching is by whole words / phrases; a lead's industry maps to the families whose terms it contains.
 */
const INDUSTRY_FAMILIES: Record<string, string[]> = {
  real_estate: ["real estate", "realtor", "realtors", "realty", "property", "properties", "listing", "listings", "broker", "brokerage", "mortgage", "landlord", "tenants"],
  food: ["restaurant", "restaurants", "cafe", "cafes", "catering", "menu", "menus", "chef", "bakery", "diner", "takeaway", "food business", "food service", "diners"],
  dental_health: ["dentist", "dentists", "dental", "clinic", "clinics", "patients", "patient", "physician", "medical practice", "chiropractor"],
  legal: ["law firm", "law firms", "lawyer", "lawyers", "attorney", "attorneys", "legal practice"],
  fitness_beauty: ["gym", "gyms", "fitness", "salon", "salons", "spa", "barber", "yoga", "personal trainer"],
  automotive: ["dealership", "dealerships", "car dealer", "auto repair", "mechanic", "garage"],
  construction: ["contractor", "contractors", "construction", "roofing", "plumber", "plumbing", "electrician", "builders"],
  education: ["school", "schools", "tutoring", "academy", "students", "university"],
  retail_ecom: ["retail", "retailer", "e-commerce", "ecommerce", "online store", "boutique"],
};

function termRegex(t: string) { return new RegExp(`(^|[^a-z])${t.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i"); }

/** Families a free-text industry belongs to (e.g. "real estate agent" -> real_estate). */
export function industryFamilies(industry: string | null | undefined): string[] {
  const t = (industry ?? "").toLowerCase();
  if (!t.trim()) return [];
  const hits = Object.entries(INDUSTRY_FAMILIES).filter(([, terms]) => terms.some((w) => termRegex(w).test(t)));
  return hits.map(([k]) => k);
}

/** Issues when the email talks about a DIFFERENT industry family than the lead's own. */
export function industryMismatch(text: string, industry: string | null | undefined): string[] {
  const own = industryFamilies(industry);
  if (!own.length) return [];
  const bad: string[] = [];
  for (const [family, terms] of Object.entries(INDUSTRY_FAMILIES)) {
    if (own.includes(family)) continue;
    const hit = terms.find((w) => termRegex(w).test(text));
    if (hit) bad.push(`mentions "${hit}" (${family}) but the lead is in ${industry}`);
  }
  return bad;
}

export function lintOutreachEmail(d: Draft, opts: { firstTouch?: boolean; earlierBodies?: string[]; industry?: string | null } = { firstTouch: true }): string[] {
  const issues: string[] = [];
  const subject = d.subject.trim();
  const body = d.body.trim();
  const text = `${subject}\n${body}`.toLowerCase();

  if (!subject) issues.push("empty subject");
  if (subject.length > 50) issues.push("subject longer than 50 characters");
  if (/[!?]{2,}/.test(subject) || subject.includes("!")) issues.push("subject contains exclamation marks");
  if (/^(re|fwd?|fw)\s*:/i.test(subject)) issues.push("subject fakes a reply/forward");
  if (/\p{Extended_Pictographic}/u.test(text)) issues.push("contains emoji");

  for (const m of industryMismatch(`${subject}\n${body}`, opts.industry)) issues.push(`wrong industry: ${m}`);
  // AIDA: every email must end with an Action - one short question the reader can answer.
  if (!body.includes("?")) issues.push("no call to action (AIDA needs a closing question)");

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
  // One easy call to action: a very long closing question is a demand, not an easy ask.
  const lastQuestion = body.split(/(?<=[.?!])\s+|\n+/).filter((x) => x.trim().endsWith("?")).pop();
  if (lastQuestion && wordCount(lastQuestion) > 25) issues.push("closing question too long");
  if ((body.match(/\?/g) ?? []).length > 2) issues.push("more than two questions");
  // The subject must relate to the body, otherwise it reads as clickbait.
  if (opts.firstTouch !== false && !subjectMatchesBody(subject, body)) issues.push("subject does not match the email");
  if (opts.earlierBodies?.length && repeatedWordingShare(body, opts.earlierBodies) > 0.35) issues.push("repeats wording from earlier emails");
  const score = spamScore(d);
  if (score.total >= SPAM_SCORE_LIMIT) issues.push(`spam score ${score.total} (limit ${SPAM_SCORE_LIMIT}): ${score.hits.join(", ")}`);
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.3) issues.push("too much capitalisation");
  return issues;
}
