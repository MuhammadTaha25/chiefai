import type { BusinessContext, ContextPurpose } from "@/lib/business-context";

/**
 * Field → destination map for the business onboarding form.
 *
 * Every field the form collects must have a defined purpose: which context
 * value it becomes, which retrieval purposes (content / comment / dm) put it
 * in front of the model, and what it ultimately influences. tests/
 * business-context.test.ts loads a fully populated context and asserts that
 * each entry's `purposes` really do surface the value — so a field cannot be
 * added to the form, or dropped from retrieval, without this table (and the
 * test) noticing. A field with no downstream use must be removed from the form.
 *
 * `strategyOnly` fields do not appear in the prompt text; they steer the
 * strategy layer (content-strategy.ts / social-content.ts) instead, and are
 * covered by their own assertions in the test.
 */
export interface FieldDestination {
  /** Key in the POST /api/settings/business-profile body. */
  field: string;
  section: "A Business" | "B Products" | "C Audience" | "D Positioning" | "E Brand" | "F Goals" | "G CTA" | "Additional";
  /** Where it is stored: clients.<col> or client_social_profile.<col>. */
  storedIn: string;
  /** BusinessContext property it is loaded into. */
  contextKey: keyof BusinessContext;
  /** Retrieval purposes whose prompt text must contain it. */
  purposes: ContextPurpose[];
  strategyOnly?: boolean;
  /** What it influences. */
  drives: string[];
}

const ALL: ContextPurpose[] = ["content", "comment", "dm", "general"];
const CONTENT: ContextPurpose[] = ["content", "general"];

export const FIELD_DESTINATIONS: FieldDestination[] = [
  { field: "company_name", section: "A Business", storedIn: "clients.company_name", contextKey: "businessName", purposes: ALL, drives: ["captions", "comment/DM replies", "image prompts"] },
  { field: "website", section: "A Business", storedIn: "client_social_profile.website", contextKey: "website", purposes: ALL, drives: ["CTA destination fallback", "comment/DM replies"] },
  { field: "niche", section: "A Business", storedIn: "client_social_profile.niche", contextKey: "industry", purposes: ALL, drives: ["topic generation", "hashtags", "comment/DM replies"] },
  { field: "business_description", section: "A Business", storedIn: "client_social_profile.business_description", contextKey: "description", purposes: ALL, drives: ["all content", "comment/DM replies", "DM qualification"] },
  { field: "location", section: "A Business", storedIn: "client_social_profile.location", contextKey: "location", purposes: ALL, drives: ["service-area questions in comments/DMs", "local hashtags/topics"] },
  { field: "products", section: "B Products", storedIn: "client_social_profile.products", contextKey: "products", purposes: ALL, drives: ["product/service posts", "solution content", "price/feature answers in comments/DMs"] },
  { field: "focus_products", section: "B Products", storedIn: "client_social_profile.focus_products", contextKey: "focusProducts", purposes: [], strategyOnly: true, drives: ["which product each post features (rotation is restricted to these)"] },
  { field: "target_audience", section: "C Audience", storedIn: "client_social_profile.target_audience", contextKey: "targetAudience", purposes: ALL, drives: ["audience each post addresses", "reply tone", "DM qualification"] },
  { field: "pain_points", section: "C Audience", storedIn: "client_social_profile.pain_points", contextKey: "painPoints", purposes: ALL, drives: ["problem-awareness + educational posts", "video hooks", "comment/DM empathy"] },
  { field: "desired_outcomes", section: "C Audience", storedIn: "client_social_profile.desired_outcomes", contextKey: "desiredOutcomes", purposes: ALL, drives: ["solution + conversion posts", "benefit framing in DMs"] },
  { field: "why_choose_us", section: "D Positioning", storedIn: "client_social_profile.why_choose_us", contextKey: "whyChooseUs", purposes: ALL, drives: ["captions", "video scripts", "DM answers to 'why you?'"] },
  { field: "usps", section: "D Positioning", storedIn: "client_social_profile.usps", contextKey: "uniqueSellingPoints", purposes: ALL, drives: ["promotional posts", "captions", "DM replies"] },
  { field: "proof", section: "D Positioning", storedIn: "client_social_profile.proof", contextKey: "proof", purposes: ["content", "dm", "general"], drives: ["trust pillar (weight is 0 when empty — proof is never invented)", "social-proof captions", "DM credibility answers"] },
  { field: "tone_of_voice", section: "E Brand", storedIn: "client_social_profile.tone_of_voice", contextKey: "brandVoice", purposes: ALL, drives: ["captions", "comment replies", "DM replies", "story text"] },
  { field: "tagline", section: "E Brand", storedIn: "client_social_profile.tagline", contextKey: "tagline", purposes: CONTENT, drives: ["captions", "video scripts"] },
  { field: "must_not_say", section: "E Brand", storedIn: "client_social_profile.must_not_say", contextKey: "mustNotSay", purposes: ALL, drives: ["prompt rule + code validation (brand-guard) of captions, comments, DMs"] },
  { field: "negative_constraints", section: "E Brand", storedIn: "client_social_profile.negative_constraints", contextKey: "negativeConstraints", purposes: ALL, drives: ["prompt rule + code validation of captions, comments, DMs"] },
  { field: "visual_style", section: "E Brand", storedIn: "client_social_profile.visual_style", contextKey: "visualStyle", purposes: CONTENT, drives: ["image + video prompts"] },
  { field: "brand_colors", section: "E Brand", storedIn: "client_social_profile.brand_colors", contextKey: "brandColors", purposes: CONTENT, drives: ["image + video prompts"] },
  { field: "language", section: "E Brand", storedIn: "client_social_profile.language", contextKey: "language", purposes: ALL, drives: ["language of every caption/reply"] },
  { field: "emoji_style", section: "E Brand", storedIn: "client_social_profile.emoji_style", contextKey: "emojiStyle", purposes: ALL, drives: ["emoji use in captions/replies"] },
  { field: "caption_styles", section: "E Brand", storedIn: "client_social_profile.caption_styles", contextKey: "captionStyles", purposes: CONTENT, drives: ["caption structure"] },
  { field: "brand_keywords", section: "E Brand", storedIn: "client_social_profile.brand_keywords", contextKey: "brandKeywords", purposes: CONTENT, drives: ["hashtags", "topic seeds"] },
  { field: "content_pillars", section: "E Brand", storedIn: "client_social_profile.content_pillars", contextKey: "contentPillars", purposes: [], strategyOnly: true, drives: ["owner-preferred themes offered to the topic writer within each pillar"] },
  { field: "primary_goal", section: "F Goals", storedIn: "client_social_profile.primary_goal", contextKey: "primaryGoal", purposes: CONTENT, drives: ["content-pillar mix (pillarWeights)"] },
  { field: "secondary_goal", section: "F Goals", storedIn: "client_social_profile.secondary_goal", contextKey: "secondaryGoal", purposes: CONTENT, drives: ["content-pillar mix at half weight"] },
  { field: "primary_cta", section: "G CTA", storedIn: "client_social_profile.primary_cta", contextKey: "primaryCta", purposes: ALL, drives: ["post/story CTA", "comment follow-up", "DM conversion step"] },
  { field: "cta_destination", section: "G CTA", storedIn: "client_social_profile.cta_destination", contextKey: "ctaDestination", purposes: ALL, drives: ["CTA link/number in posts", "where replies send the customer"] },
  { field: "cta_phrase", section: "G CTA", storedIn: "client_social_profile.cta_phrase", contextKey: "ctaPhrase", purposes: ALL, drives: ["exact CTA wording on conversion/solution posts", "replies"] },
  { field: "preferred_ctas", section: "G CTA", storedIn: "client_social_profile.preferred_ctas", contextKey: "preferredCtas", purposes: CONTENT, drives: ["alternative CTAs the writer may draw on"] },
  { field: "faqs", section: "Additional", storedIn: "client_social_profile.faqs", contextKey: "faqs", purposes: ALL, drives: ["comment/DM answers", "educational topics"] },
  { field: "offers", section: "Additional", storedIn: "client_social_profile.offers", contextKey: "offers", purposes: ALL, drives: ["conversion posts (only real offers)", "replies"] },
  { field: "pricing_info", section: "Additional", storedIn: "client_social_profile.pricing_info", contextKey: "pricingInfo", purposes: ALL, drives: ["price answers; also the allow-list for amounts in any output (brand-guard)"] },
  { field: "must_say", section: "Additional", storedIn: "client_social_profile.must_say", contextKey: "mustSay", purposes: ALL, drives: ["required wording in captions/replies"] },
  { field: "contact_method", section: "Additional", storedIn: "client_social_profile.contact_method", contextKey: "contactMethod", purposes: ALL, drives: ["how replies tell customers to reach the team"] },
  { field: "booking_method", section: "Additional", storedIn: "client_social_profile.booking_method", contextKey: "bookingMethod", purposes: ALL, drives: ["booking answers in replies"] },
  { field: "business_hours", section: "Additional", storedIn: "client_social_profile.business_hours", contextKey: "businessHours", purposes: ["comment", "dm", "general"], drives: ["availability answers"] },
];
