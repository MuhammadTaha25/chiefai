/**
 * A client's own approved cold-email template. Only these placeholders exist; anything else in braces is rejected at
 * save time so a typo never reaches a prospect as "{compnay}". Rendering never invents a value: a missing value falls
 * back to a neutral phrase (or nothing), and the rendered email still goes through the same lint as the fixed template.
 */
export const TEMPLATE_VARIABLES = ["first_name", "company", "industry", "job_title", "sender_company", "website"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface TemplateValues {
  first_name?: string | null;
  company?: string | null;
  industry?: string | null;
  job_title?: string | null;
  sender_company?: string | null;
  website?: string | null;
}

const TOKEN = /\{([a-zA-Z_]+)\}/g;
const FALLBACK: Record<TemplateVariable, string> = {
  first_name: "there",
  company: "your company",
  industry: "",
  job_title: "",
  sender_company: "",
  website: "",
};

/** Placeholders in the text that are not one of TEMPLATE_VARIABLES. */
export function unknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(m[1])) out.add(m[1]);
  }
  return [...out];
}

function tidy(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

export function renderCustomTemplate(subject: string, body: string, values: TemplateValues): { subject: string; body: string } {
  // {first_name} is the FIRST word of whatever name we hold ("Sam Agent" -> "Sam"), the same rule the fixed template uses.
  const pick = (k: TemplateVariable): string => {
    const v = tidy(values[k]);
    return (k === "first_name" ? v.split(" ")[0] : v) || FALLBACK[k];
  };
  const fill = (text: string) =>
    text.replace(TOKEN, (whole, key: string) =>
      (TEMPLATE_VARIABLES as readonly string[]).includes(key) ? pick(key as TemplateVariable) : whole
    );
  return { subject: tidy(fill(subject)).slice(0, 60), body: fill(body).trim() };
}

/** Sample values used to lint a template when the client saves it. */
export const SAMPLE_VALUES: TemplateValues = {
  first_name: "Sam",
  company: "Acme Dental",
  industry: "dental care",
  job_title: "Owner",
  sender_company: "Your Company",
  website: "example.com",
};
