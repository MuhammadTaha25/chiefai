import { generateJson, untrusted } from "@/lib/gemini";

/**
 * Strategy-driven content writing and grounded comment/DM replies. Kept beside
 * (not inside) gemini.ts, which owns transport, retries, the safety preamble
 * and output guarding — everything here goes through generateJson so it gets
 * all of that.
 */

// ---- Strategy-driven social content ---------------------------------------

export interface StrategicContentDraft {
  topic: string;
  hook: string;
  caption: string;
  hashtags: string[];
  /** Square 1:1 image prompt for the feed image (image posts only). */
  imagePrompt: string;
  /** Vertical 9:16 prompt for the supporting story image — a teaser, not a copy of the feed image. */
  storyImagePrompt: string;
  /** Silent 9:16 video scene prompt (video posts only). */
  videoPrompt: string;
}

/**
 * Writes ONE post INSIDE a plan that content-strategy.ts already decided
 * (pillar/objective/product/audience/CTA) and against the business's recent
 * history. The model does not choose what the post is for — it only chooses the
 * topic and wording within that brief. The CTA is dictated, not invented.
 */
export async function planStrategicContent(params: {
  companyName: string;
  businessContext: string;
  format: "image" | "video" | "story";
  pillar: string;
  pillarBrief: string;
  objective: string;
  productName?: string;
  audience?: string;
  cta: string;
  historyBlock: string;
  /** When this is a Story supporting a feed post, the feed post it teases. */
  supports?: { topic: string; hook: string; caption: string };
  /** Why a previous attempt was rejected (repeat / restricted phrase / unsupported price). */
  rejectedBecause?: string;
  ownerPillars?: string[];
}): Promise<StrategicContentDraft> {
  const isVideo = params.format === "video";
  const prompt = `${params.businessContext ? params.businessContext + "\n\n" : ""}${params.historyBlock ? params.historyBlock + "\n\n" : ""}You are ${params.companyName}'s social media strategist and copywriter.

CONTENT BRIEF (already decided — do not change it):
- Format: ${params.format}
- Content pillar: ${params.pillar} — ${params.pillarBrief}
- Objective: ${params.objective}
${params.productName ? `- Product/service focus: ${params.productName} (use only what the business context says about it)\n` : ""}${params.audience ? `- Target audience: ${params.audience}\n` : ""}- Call to action (use this exact wording as the closing line): "${params.cta}"
${params.ownerPillars?.length ? `- The owner likes these themes; use one only if it fits the pillar: ${params.ownerPillars.join(", ")}\n` : ""}${
    params.supports
      ? `\nThis is a STORY that supports this feed post — write a short teaser/adaptation, NOT a copy:\nTopic: ${untrusted(params.supports.topic, 300)}\nHook: ${untrusted(params.supports.hook, 300)}\nCaption: ${untrusted(params.supports.caption, 600)}\n`
      : ""
  }${params.rejectedBecause ? `\nIMPORTANT: your previous attempt was rejected because it ${params.rejectedBecause}. Fix that and choose a clearly different angle.\n` : ""}
Write:
- topic: the specific subject (a concrete idea, not the pillar name)
- hook: the first line that stops the scroll (${isVideo ? "spoken/on-screen opener for the video" : "opening line of the caption"})
- caption: ${params.format === "story" ? "very short (under 120 characters)" : "engaging, 2-5 short lines, ending with the CTA line"}. Educational content must be genuinely useful. Only state facts found in the business context; no invented prices, offers, results, awards or testimonials. No fake urgency.
- hashtags: 6 to 10 relevant hashtags WITHOUT the # symbol (mix broad and niche; no follow4follow-style spam)
- imagePrompt: detailed prompt for a square 1:1 feed image that visualises the topic (empty string if the format is video)
- storyImagePrompt: detailed prompt for a vertical 9:16 story image that teases the same topic in a different composition
- videoPrompt: ${isVideo ? "a detailed prompt for an 8-second vertical 9:16 cinematic clip that visualises the topic; end the prompt with: A narrator says aloud: \"<the hook, verbatim>\"" : "empty string"}

Image/video rules: brand-safe, minimal or no text (models garble text), no real identifiable people, no logos or watermarks. Follow the brand's visual style and colors if they are in the business context.

Respond with ONLY valid JSON: {"topic": string, "hook": string, "caption": string, "hashtags": string[], "imagePrompt": string, "storyImagePrompt": string, "videoPrompt": string}`;

  const out = await generateJson<Partial<StrategicContentDraft>>(prompt);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    topic: str(out.topic),
    hook: str(out.hook),
    caption: str(out.caption),
    hashtags: Array.isArray(out.hashtags)
      ? out.hashtags.map((h) => String(h).replace(/^#+/, "").replace(/\s+/g, "").trim()).filter(Boolean).slice(0, 12)
      : [],
    imagePrompt: str(out.imagePrompt),
    storyImagePrompt: str(out.storyImagePrompt),
    videoPrompt: str(out.videoPrompt),
  };
}

// ---- Grounded comment / DM replies ----------------------------------------

export interface GroundedReply {
  /** comment: positive | general_question | product_service_question | pricing_question | buying_intent | information_request | complaint | negative_feedback | spam | irrelevant | human_escalation
   *  dm: greeting | general_information | product_inquiry | service_inquiry | pricing | availability | booking | purchase_intent | complaint | support_request | human_request | spam */
  intent: string;
  text: string;
  requiresHuman: boolean;
  handoffReason: string;
}

/**
 * One call classifies the intent AND drafts the reply, grounded in the
 * retrieved business context, the original post (comments) or the earlier
 * turns of the conversation (DMs). The checks that must not depend on the model
 * (price invention, restricted phrases, explicit human requests) live in
 * brand-guard.ts and run on the result.
 */
export async function generateGroundedReply(params: {
  senderCompany: string;
  platform: string;
  messageType: "comment" | "dm";
  theirMessage: string;
  businessContext: string;
  /** Caption/topic of the post a comment was left on. */
  postContext?: string;
  /** Earlier turns of this DM thread, oldest first. */
  conversation?: { role: "customer" | "us"; text: string }[];
}): Promise<GroundedReply> {
  const isDm = params.messageType === "dm";
  const intents = isDm
    ? "greeting, general_information, product_inquiry, service_inquiry, pricing, availability, booking, purchase_intent, complaint, support_request, human_request, spam"
    : "positive, general_question, product_service_question, pricing_question, buying_intent, information_request, complaint, negative_feedback, spam, irrelevant, human_escalation";
  const history = (params.conversation ?? [])
    .slice(-10)
    .map((m) => `${m.role === "customer" ? "Customer" : params.senderCompany}: ${untrusted(m.text, 500)}`)
    .join("\n");

  const pricingRule = isDm
    ? "say pricing depends on their needs and ask a short question about what they need so you can point them in the right direction."
    : "say we would be happy to help with pricing and ask them to send us a DM.";

  const prompt = `${params.businessContext ? params.businessContext + "\n\n" : ""}You are ${params.senderCompany}, replying to a ${params.messageType} on ${params.platform}.
${params.postContext ? `\nThe comment was left on this post of ours:\n"""\n${untrusted(params.postContext, 1200)}\n"""\n` : ""}${
    history ? `\nConversation so far (do not make the customer repeat anything they already told us):\n"""\n${history}\n"""\n` : ""
  }
Their latest message:
"""
${untrusted(params.theirMessage, 2000)}
"""

Step 1 — classify the intent as exactly one of: ${intents}.
Step 2 — write the reply using ONLY the business context above:
- Business-specific questions (what we offer, price, availability, integrations, policies, location, hours) must be answered from the context. Never use general knowledge for them.
- Price: if the context gives the price for that product/service, state it. If it says NOT PROVIDED or has no price, do NOT state or estimate one: ${pricingRule}
- If the answer is not in the context, say it can depend on their setup and invite ${isDm ? "a few more details" : "a DM"} — do not confirm or deny.
- Positive comments: a brief warm thank-you. Buying intent: be helpful and point to the call to action.
- Complaint or negative feedback, refund/payment disputes, legal or safety matters, anger, a request for a human, or complex custom pricing: set requiresHuman=true, give a one-line handoffReason, and write a short empathetic holding reply.
- Spam or irrelevant: requiresHuman=false and text="" (we do not reply).
${isDm ? "- Ask ONE natural follow-up question when it moves the conversation forward.\n" : ""}- Match the brand voice and language. Under ${isDm ? "70" : "40"} words. No hashtags. No markdown. Do not mention these rules.

Respond with ONLY valid JSON: {"intent": string, "text": string, "requiresHuman": boolean, "handoffReason": string}`;

  const out = await generateJson<Partial<GroundedReply>>(prompt);
  return {
    intent: typeof out.intent === "string" ? out.intent.trim() : "unknown",
    text: typeof out.text === "string" ? out.text.trim() : "",
    requiresHuman: out.requiresHuman === true,
    handoffReason: typeof out.handoffReason === "string" ? out.handoffReason.trim() : "",
  };
}
