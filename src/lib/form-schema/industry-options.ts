import { FieldOption, FormValues, sameOpts } from "./types";

export const INDUSTRY_OPTIONS = sameOpts([
  "Software / SaaS",
  "AI",
  "E-commerce",
  "Real Estate",
  "Healthcare",
  "Finance",
  "Education",
  "Marketing Agency",
  "Consulting",
  "Recruitment",
  "Construction",
  "Legal",
  "Manufacturing",
  "Hospitality",
  "Automotive",
  "Professional Services",
]);

/** Interests shown for ad targeting — changes based on the client's own industry (section 1), not the target industry. */
const INTEREST_HINTS: Record<string, string[]> = {
  "Software / SaaS": ["Artificial Intelligence", "Automation", "Software", "Technology", "Startups", "SaaS tools"],
  AI: ["Artificial Intelligence", "Automation", "Machine Learning", "Technology", "Startups"],
  "E-commerce": ["Online Shopping", "Repeat Buyers", "High-Value Customers", "Product Interests", "Dropshipping"],
  "Real Estate": ["Real Estate", "Property Investment", "Home Buying", "Mortgage", "Commercial Property"],
  Healthcare: ["Health & Wellness", "Medical Services", "Patient Care", "Insurance"],
  Finance: ["Personal Finance", "Investing", "Accounting", "Business Banking"],
  Education: ["Online Learning", "Professional Development", "Certifications"],
  "Marketing Agency": ["Digital Marketing", "Advertising", "Branding", "Growth Marketing"],
  Consulting: ["Business Strategy", "Operations", "Growth Consulting"],
  Recruitment: ["Hiring", "Career Growth", "HR Software"],
  Construction: ["Home Improvement", "Contracting", "Commercial Construction"],
  Legal: ["Legal Services", "Compliance", "Business Law"],
  Manufacturing: ["Industrial Equipment", "Supply Chain", "B2B Manufacturing"],
  Hospitality: ["Travel", "Hotels", "Dining", "Events"],
  Automotive: ["Cars", "Auto Services", "Fleet Management"],
  "Professional Services": ["Business Services", "Outsourcing", "B2B Services"],
};

export function interestsForIndustry(values: FormValues): FieldOption[] {
  const industry = String(values.business_category ?? "");
  const list = INTEREST_HINTS[industry] ?? ["Business Owners", "Decision Makers", "Growth-Stage Companies"];
  return sameOpts(list);
}

/** "Who should we contact" style buyer personas, based on the target industry (lead-gen section 2). */
const CONTACT_PERSONA_HINTS: Record<string, string[]> = {
  "Real Estate": ["Property Buyers", "Investors", "Sellers", "Landlords", "Tenants"],
  "Software / SaaS": ["Founders", "CTOs", "IT Managers", "Operations Managers", "Sales Leaders"],
  "E-commerce": ["Store Owners", "Ecommerce Managers", "Marketing Leads"],
};

export function contactPersonasForIndustry(values: FormValues): FieldOption[] {
  const industries = Array.isArray(values.target_industries) ? (values.target_industries as string[]) : [];
  const hints = industries.flatMap((i) => CONTACT_PERSONA_HINTS[i] ?? []);
  const base = ["Founder", "Owner", "CEO", "Co-Founder", "CTO", "COO", "CMO", "CFO", "VP", "Director", "Head of Department", "Manager"];
  const merged = Array.from(new Set([...hints, ...base]));
  return sameOpts(merged);
}

export const COUNTRY_OPTIONS = sameOpts([
  "United States",
  "United Kingdom",
  "Canada",
  "United Arab Emirates",
  "Saudi Arabia",
  "Qatar",
  "Australia",
  "Germany",
  "France",
  "Netherlands",
  "Pakistan",
  "India",
]);

const STATE_OPTIONS: Record<string, string[]> = {
  "United States": ["California", "Texas", "New York", "Florida", "New Jersey", "Illinois", "Washington"],
  Canada: ["Ontario", "British Columbia", "Alberta", "Quebec"],
  "United Kingdom": ["England", "Scotland", "Wales", "Northern Ireland"],
  Australia: ["New South Wales", "Victoria", "Queensland", "Western Australia"],
};

export function statesForCountries(values: FormValues): FieldOption[] {
  const countries = Array.isArray(values.target_countries) ? (values.target_countries as string[]) : [];
  const list = countries.flatMap((c) => STATE_OPTIONS[c] ?? []);
  return sameOpts(list);
}

export const TECH_STACK_OPTIONS = sameOpts([
  "Shopify",
  "WordPress",
  "HubSpot",
  "Salesforce",
  "AWS",
  "Microsoft Azure",
  "Google Cloud",
  "WooCommerce",
  "Klaviyo",
  "Monday.com",
  "Semrush",
]);
