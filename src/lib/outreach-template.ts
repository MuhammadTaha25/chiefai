/**
 * The first-touch cold email is a FIXED, short, plain-text structure; only the variables change. A fixed
 * shape is what keeps it out of spam folders: no links, no hype, one question, a real signature. AI only
 * supplies two short phrases (what we help with, what it means for them) - never the structure.
 *
 *   Hi {first_name},
 *   Since {company} works in {industry}, I thought this might be relevant.
 *   We help businesses {offer}. For a business like yours, that could mean {benefit}.
 *   Is this on your radar at {company}, or is now not a good time?
 *   Best,
 *   {sender_name}
 *   {sender_company}
 *   {website}
 *
 * A variable we do not have is left out, never invented (no industry -> that clause is dropped, etc.).
 */
export interface TemplateVars {
  /** Recipient's first name; null/empty greets with "Hi there,". */
  firstName?: string | null;
  /** Recipient's company. */
  leadCompany: string;
  /** Recipient's industry, only when actually known. */
  industry?: string | null;
  /** Recipient's job title, only when actually known. Used in the opener when the industry is not. */
  jobTitle?: string | null;
  /** "automate repetitive tasks such as lead follow-ups and customer inquiries using AI" (a verb phrase). */
  offer: string;
  /** "less manual work and faster responses to potential customers" (a noun phrase). */
  benefit: string;
  senderName?: string | null;
  senderCompany: string;
  website?: string | null;
}

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/**
 * The signature shows the site as a bare domain ("infomist.com"), never "https://www..." : a first cold email
 * that contains a URL is a spam signal, and the deliverability check rejects it. Mail clients still make the
 * bare domain clickable for the reader.
 */
export function bareDomain(website: string | null | undefined): string {
  return tidy(website)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

const stripEndPunct = (s: string) => s.replace(/[.!?\s]+$/, "");

/** Small stable hash so the same lead always gets the same choice (retries never change a subject). */
function pick(seed: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

/**
 * First-touch subject for the fixed template. "Quick question about X" is the most overused cold-email subject, so
 * the pattern varies per lead. Every variant only uses facts we hold (company, first name, industry): nothing invented.
 */
export function templateSubject(company: string, firstName: string, industry: string): string {
  const options = [
    `A question about ${company}`,
    `Idea for ${company}`,
    `For the team at ${company}`,
    `${company}: worth a short chat?`,
    firstName ? `${firstName}, a thought on ${company}` : `A thought on ${company}`,
    industry ? `${company} and ${industry}` : `Something for ${company}`,
  ];
  return options[pick(`${company}|${firstName}`, options.length)].slice(0, 50).trim();
}

/** One subject-line style for the AI prompt, picked per lead so a batch does not all share one pattern. */
export function subjectStyleFor(seed: string): string {
  const styles = [
    "a short, specific question about one thing their business does (not a generic question)",
    "a plain statement of what the email is about, naming their company",
    "a short idea aimed at their type of business",
    "a lowercase, casual note, 3-5 words, naming their company or what they do",
    "a short observation about their industry or location, phrased as a topic",
  ];
  return styles[pick(seed, styles.length)];
}

export function buildTemplateEmail(v: TemplateVars): { subject: string; body: string } {
  const first = tidy(v.firstName).split(" ")[0];
  const company = tidy(v.leadCompany) || "your company";
  // A stored slug like "real_estate" must read as "real estate" in a sentence.
  const industry = tidy(v.industry).replace(/[_]+/g, " ").replace(/\s+/g, " ");

  // Opener: the most specific fact we actually have. Industry wins (unchanged behaviour); otherwise the
  // recipient's own job title; otherwise the generic line. Nothing is invented in any branch.
  const title = tidy(v.jobTitle).slice(0, 80);
  const opener = industry
    ? `Since ${company} works in ${industry}, I thought this might be relevant.`
    : title
      ? `With your role as ${title} at ${company}, I thought this might be relevant.`
      : `I'm getting in touch about ${company}.`;

  const lines = [
    `Hi ${first || "there"},`,
    "",
    opener,
    "",
    `We help businesses ${stripEndPunct(tidy(v.offer))}. For a business like yours, that could mean ${stripEndPunct(tidy(v.benefit))}.`,
    "",
    `Is this on your radar at ${company}, or is now not a good time?`,
    "",
    "Best,",
    ...[tidy(v.senderName), tidy(v.senderCompany), bareDomain(v.website)].filter(Boolean),
  ];

  return { subject: templateSubject(company, first, industry), body: lines.join("\n") };
}
