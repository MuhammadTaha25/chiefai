/**
 * Single source of truth for marketing SEO (primary keyword: "ChiefAI").
 * The visible FAQ on `/` and the FAQPage JSON-LD are both generated from FAQS,
 * so the markup always matches what users read.
 */
export const SITE = {
  name: "ChiefAI",
  keyword: "ChiefAI",
  title: "ChiefAI — AI Chief of Staff for Lead Generation, Social & Finance",
  description:
    "ChiefAI is an AI chief of staff that runs lead generation and outreach, social media and ads, and finance tracking for your business — all on one live dashboard.",
} as const;

/** Public origin, no trailing slash. Set PUBLIC_APP_URL in production. */
export function getSiteUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export const FEATURES = [
  {
    title: "AI lead generation",
    body: "Your ICP feeds an AI pipeline that finds, researches, and emails qualified leads automatically.",
  },
  {
    title: "AI social & ads",
    body: "Instagram and Facebook content, plus Google/Meta ad optimization, run themselves — you approve the budget.",
  },
  {
    title: "Live finance & projects",
    body: "Revenue, spend, and project status roll up to one dashboard, with a Chief of Staff you can just ask.",
  },
] as const;

export const FAQS = [
  {
    question: "What is ChiefAI?",
    answer:
      "ChiefAI is an AI chief of staff for your business. It runs lead generation and outreach, creates and optimizes social and ad campaigns, and tracks finance and projects, all visible on one live dashboard.",
  },
  {
    question: "How does ChiefAI generate leads?",
    answer:
      "You describe your ideal customer during onboarding. ChiefAI then finds matching businesses, researches them, and sends personalised outreach emails automatically, while you watch replies and pipeline status on the dashboard.",
  },
  {
    question: "Can ChiefAI manage my social media and ads?",
    answer:
      "Yes. ChiefAI plans and posts Instagram and Facebook content and optimizes Google and Meta ads. You stay in control by approving the budget.",
  },
  {
    question: "What does the ChiefAI Chief of Staff do?",
    answer:
      "It is an assistant you can simply ask about your company, such as revenue, spend, leads, or project status, and it answers from the live data in your dashboard.",
  },
  {
    question: "How do I get started with ChiefAI?",
    answer:
      "Create an account, complete the short onboarding about your business and ideal customer, and ChiefAI begins setting up your outreach, content, and dashboard.",
  },
] as const;

export function buildStructuredData() {
  const url = getSiteUrl();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organization`,
        name: SITE.name,
        url,
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        url,
        name: SITE.name,
        publisher: { "@id": `${url}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${url}/#app`,
        name: SITE.name,
        description: SITE.description,
        url,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
      },
      {
        "@type": "FAQPage",
        "@id": `${url}/#faq`,
        mainEntity: FAQS.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: f.answer },
        })),
      },
    ],
  };
}

/** JSON.stringify with `<` escaped so the output is safe inside a <script> tag. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
