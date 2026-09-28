import type { BusinessContext } from "@/lib/business-context";
import type { GroundedReply } from "@/lib/social-ai";

/**
 * Deterministic output validation for AI-written captions and replies. The
 * prompt already tells the model not to invent prices or use forbidden
 * phrases; this is the code-level backstop for the rules that must hold even
 * when the model doesn't comply. Pure functions, no I/O.
 */

const splitTerms = (s: string | undefined) =>
  (s ?? "")
    .split(/[\n,;]+/)
    .map((t) => t.trim().replace(/^[-•*"']+|["'.]+$/g, "").toLowerCase())
    // Only short phrases are checkable as literals ("guaranteed", "cheap").
    // A full sentence like "never quote a discount without approval" is enforced
    // by the prompt, not by substring matching.
    .filter((t) => t.length >= 3 && t.split(/\s+/).length <= 4);

/** Words/phrases the owner listed under "must never say" / "avoid" that appear in the text. */
export function restrictedPhrase(text: string, ctx: BusinessContext): string | null {
  const lower = text.toLowerCase();
  for (const term of [...splitTerms(ctx.mustNotSay), ...splitTerms(ctx.negativeConstraints)]) {
    if (lower.includes(term)) return term;
  }
  return null;
}

const MONEY =
  /(?:[$€£₨]|\brs\.?|\bpkr|\baed|\busd|\beur|\bgbp)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|pkr|aed|eur|gbp|dollars?|rupees?|dirhams?|euros?|\/\s?(?:mo|month|hr|hour|year|yr)\b)/gi;

const digits = (s: string) => s.replace(/,/g, "");

/**
 * A price/amount in the text that appears nowhere in the price sources the
 * owner provided (product prices, pricing info, offers, FAQs). Returns the
 * offending amount, or null when every amount is backed by the context.
 */
export function unsupportedPrice(text: string, ctx: BusinessContext): string | null {
  const found: string[] = [];
  for (const m of text.matchAll(MONEY)) found.push(digits(m[1] ?? m[2] ?? ""));
  if (!found.length) return null;
  const corpus = [ctx.pricingInfo, ctx.offers, ctx.faqs, ctx.services, ...(ctx.products ?? []).map((p) => `${p.price ?? ""} ${p.description ?? ""}`)]
    .filter(Boolean)
    .join(" ")
    .replace(/,/g, "");
  const known = new Set(corpus.match(/\d+(?:\.\d+)?/g) ?? []);
  return found.find((n) => n && !known.has(n)) ?? null;
}

const HUMAN_REQUEST =
  /\b(speak|talk|chat|connect)\b.{0,25}\b(human|person|someone|somebody|agent|representative|manager|team)\b|\b(real person|live agent|human agent|representative)\b|\b(someone|somebody)\b.{0,25}\b(contact|call|reach|get back|email|message)\b/i;

/** Explicit request for a person — never left to the model to notice. */
export function humanRequested(text: string): boolean {
  return HUMAN_REQUEST.test(text);
}

/** Why a piece of AI text must not go out as-is (or null if it is fine). */
export function validateOutbound(text: string, ctx: BusinessContext): string | null {
  const term = restrictedPhrase(text, ctx);
  if (term) return `contains restricted phrase "${term}"`;
  const price = unsupportedPrice(text, ctx);
  if (price) return `states an amount (${price}) that is not in the business's own pricing`;
  return null;
}

export type InteractionStatus = "pending" | "sent" | "flagged_for_human" | "send_failed" | "blocked_by_validation" | "ignored";

export interface Decision {
  action: "send" | "hold" | "ignore";
  text: string;
  intent: string;
  requiresHuman: boolean;
  handoffReason: string;
  status: InteractionStatus;
}

const HOLDING_REPLY = "Thanks for reaching out — I've passed your message to our team and someone will get back to you shortly.";

// Public comments should not carry a private matter, so they move it to DMs.
const HOLDING_COMMENT = "Thanks for letting us know — please send us a DM so our team can help you directly.";

const PRICING_FALLBACK = {
  comment: "I'd be happy to help with pricing. Please send us a DM and our team can provide the details.",
  dm: "Pricing depends on what you need. Tell me a little about it and I can help point you in the right direction.",
};

/**
 * What actually happens with the model's draft. The model classifies and
 * writes; THIS decides, so the outcomes the spec makes non-negotiable do not
 * depend on the model complying:
 *  - an explicit request for a person always escalates (with a fixed, safe
 *    holding reply — never model text)
 *  - a draft containing an amount the business never stated is replaced by the
 *    "send us a DM for pricing" answer, never sent
 *  - a draft containing a phrase the owner forbade is replaced by the holding reply
 *  - anything the model marked as needing a human (complaints, refunds, legal, custom
 *    pricing, no reliable information) gets the fixed holding reply and is flagged
 *    requires_human; the model's own wording is never sent for those
 */
export function decideReply(
  reply: GroundedReply,
  theirMessage: string,
  ctx: BusinessContext,
  messageType: "comment" | "dm"
): Decision {
  const base = { intent: reply.intent || "unknown" };

  // Anything that needs a person still gets an immediate, FIXED acknowledgement (never model text):
  // silence after a DM looks broken, and the handoff flag tells the team to follow up.
  const holding = messageType === "comment" ? HOLDING_COMMENT : HOLDING_REPLY;

  if (humanRequested(theirMessage)) {
    return { ...base, action: "send", text: holding, requiresHuman: true, handoffReason: "Customer asked for a person", status: "sent" };
  }

  if (reply.requiresHuman) {
    return { ...base, action: "send", text: holding, requiresHuman: true, handoffReason: reply.handoffReason || "Needs a human", status: "sent" };
  }

  if (!reply.text) {
    return { ...base, action: "ignore", text: "", requiresHuman: false, handoffReason: "", status: "ignored" };
  }

  if (unsupportedPrice(reply.text, ctx)) {
    return { ...base, action: "send", text: PRICING_FALLBACK[messageType], requiresHuman: false, handoffReason: "", status: "sent" };
  }

  const problem = validateOutbound(reply.text, ctx);
  if (problem) {
    return { ...base, action: "send", text: holding, requiresHuman: true, handoffReason: `Drafted reply ${problem}; sent the holding reply instead`, status: "sent" };
  }

  return { ...base, action: "send", text: reply.text, requiresHuman: false, handoffReason: "", status: "sent" };
}
