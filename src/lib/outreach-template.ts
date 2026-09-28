/**
 * The first-touch cold email is a FIXED, short, plain-text structure; only the variables change. A fixed
 * shape is what keeps it out of spam folders: no links, no hype, one question, a real signature. AI only
 * supplies two short phrases (what we help with, what it means for them) - never the structure.
 *
 *   Hi {first_name},
 *   I came across {company} and noticed you're working in {industry}.
 *   I'm reaching out because we help businesses {offer}.
 *   For a business like yours, this could mean {benefit}.
 *   Would you be open to a quick conversation to see whether this could be useful for {company}?
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

export function buildTemplateEmail(v: TemplateVars): { subject: string; body: string } {
  const first = tidy(v.firstName).split(" ")[0];
  const company = tidy(v.leadCompany) || "your company";
  const industry = tidy(v.industry);

  const opener = industry
    ? `I came across ${company} and noticed you're working in ${industry}.`
    : `I came across ${company} and wanted to reach out.`;

  const lines = [
    `Hi ${first || "there"},`,
    "",
    opener,
    "",
    `I'm reaching out because we help businesses ${stripEndPunct(tidy(v.offer))}.`,
    "",
    `For a business like yours, this could mean ${stripEndPunct(tidy(v.benefit))}.`,
    "",
    `Would you be open to a quick conversation to see whether this could be useful for ${company}?`,
    "",
    "Best,",
    ...[tidy(v.senderName), tidy(v.senderCompany), bareDomain(v.website)].filter(Boolean),
  ];

  return { subject: `Quick question about ${company}`.slice(0, 60), body: lines.join("\n") };
}
