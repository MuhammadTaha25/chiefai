import { SectionConfig, sameOpts, sameOptsWithSoon, opts } from "./types";
import {
  UNSUPPORTED_ACTIONS,
  UNSUPPORTED_DESTINATIONS,
  UNSUPPORTED_FORMATS,
  UNSUPPORTED_GOALS,
  UNSUPPORTED_PLATFORMS,
} from "../ad-validation.ts";
import { COUNTRY_OPTIONS, statesForCountries, interestsForIndustry } from "./industry-options";

/**
 * Builds the ads brief schema locked to a single platform. The "where do you
 * want to advertise" multiselect used to list Facebook + Instagram regardless
 * of which connected account (Facebook Ads card vs Instagram Ads card) the
 * brief was opened from — confusing, since this app launches each card's ad
 * only on that card's own connection. Each card now only ever offers its own
 * platform here (still a required tap-to-confirm chip, not auto-selected).
 */
export function buildAdsSchema(lockedPlatform: "Facebook" | "Instagram"): SectionConfig[] {
  return ADS_SCHEMA.map((section) =>
    section.id !== "platforms"
      ? section
      : {
          ...section,
          fields: section.fields.map((field) =>
            field.id !== "platforms" ? field : { ...field, options: sameOpts([lockedPlatform]) }
          ),
        }
  );
}

export const ADS_SCHEMA: SectionConfig[] = [
  {
    id: "business_offer",
    title: "Business & Offer",
    fields: [
      {
        id: "advertising_what",
        label: "What are you advertising?",
        help: "Tell us the product or service this ad campaign is promoting.",
        example: "AI software, web development, real estate, an online course, an e-commerce product…",
        type: "text",
        required: true,
      },
      {
        id: "offer",
        label: "What is your offer?",
        help: "What will people get if they respond to this ad?",
        example: "Free trial, 20% off, free consultation, book a demo, free quote…",
        type: "text",
      },
      {
        id: "why_choose_you",
        label: "Why should customers choose you?",
        help: "What makes you different from competitors? Pick everything that applies.",
        type: "multiselect",
        options: sameOpts(["Lower price", "Better quality", "Faster service", "More experience", "Local support", "AI-powered"]),
        allowCustom: true,
      },
    ],
  },
  {
    id: "campaign_goal",
    title: "Campaign Goal",
    fields: [
      {
        id: "desired_result",
        label: "What result do you want?",
        help: "What does success look like for this campaign?",
        type: "select",
        options: sameOptsWithSoon(["Leads", "Sales", "Website visits", "WhatsApp messages", "Phone calls", "Bookings", "App downloads", "Brand awareness"], UNSUPPORTED_GOALS),
        required: true,
      },
      {
        id: "post_ad_action",
        label: "What should people do after seeing the ad?",
        help: "The specific action you want a viewer to take.",
        type: "select",
        options: sameOptsWithSoon(["Fill a form", "Buy", "Book a call", "Send WhatsApp message", "Call", "Visit website", "Download app"], UNSUPPORTED_ACTIONS),
      },
    ],
  },
  {
    id: "audience",
    title: "Target Audience",
    fields: [
      {
        id: "audience_description",
        label: "Who should see your ads?",
        help: "Describe the kind of person you want to reach, in your own words.",
        example: "Business owners in the US who need AI automation.",
        type: "textarea",
        allowAI: true,
      },
      {
        id: "age_range",
        label: "Age",
        help: "What age group is most likely to buy from you?",
        type: "select",
        options: sameOpts(["18–24", "25–34", "35–44", "45–54", "55+", "All ages"]),
        allowAI: true,
      },
      {
        id: "gender",
        label: "Gender",
        help: "Only narrow this down if your product is genuinely gender-specific.",
        type: "select",
        options: sameOpts(["Everyone", "Men", "Women"]),
        allowAI: true,
      },
      {
        id: "interests",
        label: "Interests",
        help: "Topics and interests your ideal customer is likely to follow.",
        type: "multiselect",
        options: interestsForIndustry,
        allowCustom: true,
      },
    ],
  },
  {
    id: "location_demo",
    title: "Location & Demographics",
    fields: [
      {
        id: "ad_countries",
        label: "Countries",
        help: "Which countries should see this ad?",
        type: "multiselect",
        options: COUNTRY_OPTIONS,
        allowCustom: true,
        required: true,
      },
      {
        id: "ad_states",
        label: "States / regions",
        help: "Narrow it down further, or leave empty to target the whole country.",
        type: "multiselect",
        options: statesForCountries,
        showIf: (v) => Array.isArray(v.ad_countries) && (v.ad_countries as string[]).length > 0,
      },
      {
        id: "ad_cities",
        label: "Cities",
        help: "Leave empty if you want the whole country or region.",
        example: "New York, Los Angeles, London, Dubai, Toronto…",
        type: "tags",
      },
      {
        id: "language",
        label: "Language",
        help: "What language should the ad be shown in?",
        example: "English, Arabic, Urdu…",
        type: "text",
        allowAI: true,
      },
    ],
  },
  {
    id: "existing_audience",
    title: "Existing Audience",
    fields: [
      {
        id: "has_existing_audience",
        label: "Do you already have customers or an audience?",
        help: "If yes, we can advertise directly to them, or find people similar to them.",
        type: "yesno",
      },
      {
        id: "existing_audience_sources",
        label: "Which audiences do you have?",
        help: "Select everything you can provide to us.",
        type: "multiselect",
        options: sameOpts(["Customer list", "Website visitors", "Social media audience", "App users", "Previous leads", "Video viewers"]),
        required: true,
        showIf: (v) => v.has_existing_audience === "yes",
      },
      {
        id: "target_similar",
        label: "Do you want to target similar people?",
        help: "Lookalike targeting needs an audience uploaded to Meta first, which isn't supported yet — leave this as No.",
        type: "select",
        options: opts([
          ["yes", "Yes"],
          ["no", "No"],
        ]),
        allowAI: true,
        showIf: (v) => v.has_existing_audience === "yes",
      },
    ],
  },
  {
    id: "budget",
    title: "Budget",
    fields: [
      {
        id: "daily_budget",
        label: "Daily budget",
        help: "How much are you comfortable spending per day?",
        example: "$10/day, $25/day, $50/day, $100/day, $250/day…",
        type: "number",
        required: true,
      },
      {
        id: "campaign_duration",
        label: "Campaign duration",
        help: "How long should this campaign run?",
        type: "select",
        options: sameOpts(["7 days", "14 days", "30 days", "60 days", "90 days"]),
        allowCustom: true,
      },
      {
        id: "start_date",
        label: "Start date",
        help: "When should the campaign begin?",
        type: "date",
      },
      {
        id: "end_date",
        label: "End date",
        help: "When should the campaign stop? Leave empty to keep it running.",
        type: "date",
      },
    ],
  },
  {
    id: "platforms",
    title: "Platforms",
    fields: [
      {
        id: "platforms",
        label: "Where do you want to advertise?",
        help: "Choose where you want potential customers to see your ads.",
        type: "multiselect",
        options: sameOptsWithSoon(["Facebook", "Instagram", "Google", "YouTube", "LinkedIn", "TikTok"], UNSUPPORTED_PLATFORMS),
        required: true,
      },
    ],
  },
  {
    id: "creative",
    title: "Ad Creative",
    fields: [
      {
        id: "creative_focus",
        label: "What should the ad focus on?",
        help: "The main angle the ad should lead with.",
        type: "select",
        options: sameOpts(["Problem", "Benefit", "Price", "Offer", "Discount", "Results", "Social proof", "Product features"]),
        allowAI: true,
      },
      {
        id: "ad_format",
        label: "Ad format",
        help: "What kind of creative should we produce?",
        type: "select",
        options: sameOptsWithSoon(["Image", "Video", "Reel", "Carousel", "Existing post"], UNSUPPORTED_FORMATS),
      },
      {
        id: "has_creative_assets",
        label: "Do you already have images or videos?",
        help: "If not, we'll generate creative concepts or scripts for you.",
        type: "yesno",
      },
      {
        id: "creative_media",
        label: "Upload your image or video",
        help: "We'll use this exact file in your ad instead of generating one. Images up to 10 MB, video up to 300 MB.",
        type: "file",
        accept: "image/*,video/*",
        showIf: (v) => v.has_creative_assets === "yes",
      },
      {
        id: "main_message",
        label: "Main message",
        help: "The single most important thing you want the ad to say.",
        example: "Automate your business with AI and save 20 hours every week.",
        type: "textarea",
      },
      {
        id: "ad_cta",
        label: "Call to action button",
        help: "The button text shown on the ad.",
        type: "select",
        options: sameOpts(["Learn More", "Book Now", "Get Quote", "Buy Now", "Sign Up", "Contact Us", "WhatsApp", "Download"]),
        allowCustom: true,
      },
    ],
  },
  {
    id: "landing_tracking",
    title: "Landing Page & Tracking",
    fields: [
      {
        id: "landing_destination",
        label: "Where should people go?",
        help: "Where does someone end up after clicking the ad?",
        type: "select",
        options: sameOptsWithSoon(["Website", "Landing page", "WhatsApp", "Lead form", "Phone", "Calendly", "Checkout"], UNSUPPORTED_DESTINATIONS),
        required: true,
      },
      {
        id: "landing_page_url",
        label: "Landing page URL",
        help: "The exact page the ad should link to.",
        example: "https://www.yourcompany.com/offer",
        type: "url",
        showIf: (v) => ["Website", "Landing page", "Checkout", "Calendly"].includes(String(v.landing_destination ?? "")),
      },
      {
        id: "conversion_tracking",
        label: "Conversion tracking",
        help: "Do you already have tracking (like a Facebook Pixel or Google Tag) installed on your site?",
        type: "select",
        options: sameOpts(["Already installed", "Not installed", "Not sure"]),
        allowAI: true,
      },
    ],
  },
  {
    id: "exclusions",
    title: "Exclusions",
    fields: [
      {
        id: "ad_exclusions",
        label: "Who should NOT see the ads?",
        help: "Anyone we should specifically avoid showing this ad to.",
        example: "Existing customers, employees, competitors, existing leads…",
        type: "tags",
      },
    ],
  },
];
