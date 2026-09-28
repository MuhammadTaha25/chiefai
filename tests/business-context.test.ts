import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveBusinessContext, rankProducts, parseProducts, type BusinessContext, type ContextPurpose } from "../src/lib/business-context.ts";
import { FIELD_DESTINATIONS } from "../src/lib/business-field-map.ts";
import {
  choosePillar, chooseProduct, pillarWeights, planNextContent, repeatsHistory, resolveCta, similarity, type HistoryItem,
} from "../src/lib/content-strategy.ts";
import { decideReply, humanRequested, restrictedPhrase, unsupportedPrice, validateOutbound } from "../src/lib/brand-guard.ts";

const base = (over: Partial<BusinessContext> = {}): BusinessContext => ({
  clientId: "client-A",
  businessName: "ABC AI Solutions",
  industry: "AI Automation",
  description: "We automate customer support and lead follow-up.",
  products: [
    { name: "AI Customer Support Automation", description: "Automates repetitive support chats", benefit: "Less manual support work" },
    { name: "Lead Follow-up Automation", description: "Follows up new leads fast", benefit: "Faster lead response", price: "$499 per month" },
  ],
  targetAudience: ["Small business owners"],
  painPoints: "Too many repetitive questions",
  desiredOutcomes: "Save time",
  primaryGoal: "lead_generation",
  primaryCta: "send_dm",
  ctaPhrase: "DM us to discuss what you can automate.",
  brandVoice: ["Professional"],
  ...over,
});

const LIST_KEYS = new Set(["targetAudience", "brandVoice", "brandColors", "captionStyles", "contentPillars", "preferredCtas", "focusProducts"]);

// ---- every collected field reaches the prompts it claims to ----------------

test("each form field's declared purposes actually surface its value in retrieval", () => {
  for (const f of FIELD_DESTINATIONS) {
    if (f.strategyOnly) continue;
    const ctx: BusinessContext = { clientId: "c" };
    const marker = `MARK_${f.contextKey}`;
    if (f.contextKey === "products") ctx.products = [{ name: marker }];
    else if (LIST_KEYS.has(f.contextKey)) (ctx as unknown as Record<string, unknown>)[f.contextKey] = [marker];
    else (ctx as unknown as Record<string, unknown>)[f.contextKey] = marker;
    for (const purpose of f.purposes) {
      const out = retrieveBusinessContext(ctx, { purpose });
      assert.ok(out.text.includes(marker), `${f.field} is missing from "${purpose}" retrieval`);
    }
  }
});

test("every field-map entry has a real downstream use", () => {
  for (const f of FIELD_DESTINATIONS) {
    assert.ok(f.strategyOnly || f.purposes.length > 0, `${f.field} feeds no retrieval purpose`);
    assert.ok(f.drives.length > 0, `${f.field} drives nothing`);
  }
});

// ---- retrieval ----------------------------------------------------------------

test("retrieval ranks the product a customer mentions and marks a missing price as NOT PROVIDED", () => {
  const out = retrieveBusinessContext(base(), { purpose: "dm", query: "how much is the customer support automation?" });
  assert.deepEqual(out.reference.products, ["AI Customer Support Automation"]);
  assert.match(out.text, /Price: NOT PROVIDED/);
  assert.doesNotMatch(out.text, /\$499/);
});

test("a stated price is included for that product", () => {
  const out = retrieveBusinessContext(base(), { purpose: "comment", query: "price of lead follow up?" });
  assert.match(out.text, /\$499 per month/);
});

test("replies do not receive content-only sections; content does not receive business hours", () => {
  const ctx = base({ visualStyle: "VISUAL", primaryGoal: "sales", businessHours: "HOURS", tagline: "TAG" });
  const dm = retrieveBusinessContext(ctx, { purpose: "dm" }).text;
  const content = retrieveBusinessContext(ctx, { purpose: "content" }).text;
  assert.doesNotMatch(dm, /VISUAL|TAG/);
  assert.match(content, /VISUAL/);
  assert.doesNotMatch(content, /HOURS/);
  assert.match(dm, /HOURS/);
});

test("retrieval carries the grounding rules and only that one business's data", () => {
  const a = retrieveBusinessContext(base({ clientId: "A", businessName: "ABC Fitness" }), { purpose: "comment" });
  const b = retrieveBusinessContext({ clientId: "B", businessName: "XYZ Dental", products: [{ name: "Whitening" }] }, { purpose: "comment", query: "whitening" });
  assert.match(a.text, /Never invent prices/);
  assert.doesNotMatch(b.text, /ABC Fitness|Automation/);
  assert.equal(b.reference.clientId, "B");
});

test("content leads with focus products when the owner set any", () => {
  const ctx = base({ focusProducts: ["Lead Follow-up Automation"] });
  assert.deepEqual(rankProducts(ctx, { purpose: "content" }).map((p) => p.name), ["Lead Follow-up Automation"]);
});

test("parseProducts drops nameless rows", () => {
  assert.deepEqual(parseProducts([{ name: " " }, { name: "A", price: " " }]), [{ name: "A", description: undefined, benefit: undefined, price: undefined, url: undefined }]);
});

// ---- strategy -----------------------------------------------------------------

test("goal changes the pillar mix and trust needs owner-supplied proof", () => {
  const leads = pillarWeights(base({ primaryGoal: "lead_generation", proof: undefined }));
  const edu = pillarWeights(base({ primaryGoal: "education", proof: undefined }));
  assert.equal(leads.trust, 0);
  assert.ok(leads.conversion > edu.conversion);
  assert.ok(edu.educational > leads.educational);
  assert.ok(pillarWeights(base({ primaryGoal: "trust", proof: "ISO 9001 certified" })).trust > 0);
});

test("pillars rotate and never repeat back to back; not every post is promotional", () => {
  const ctx = base();
  const history: HistoryItem[] = [];
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const pillar = choosePillar(ctx, history);
    if (history[0]) assert.notEqual(pillar, history[0].content_pillar);
    seen.push(pillar);
    history.unshift({ content_pillar: pillar });
  }
  assert.ok(seen.filter((p) => p === "conversion").length <= 4, "conversion should stay a minority");
  for (const p of ["educational", "problem_awareness", "solution", "engagement", "conversion"]) assert.ok(seen.includes(p), `${p} never scheduled`);
  assert.ok(!seen.includes("trust"), "trust content without proof would have to be invented");
});

test("products rotate through the least recently used", () => {
  const ctx = base();
  assert.equal(chooseProduct(ctx, [{ product_name: "AI Customer Support Automation" }]), "Lead Follow-up Automation");
  assert.equal(chooseProduct(ctx, [{ product_name: "Lead Follow-up Automation" }, { product_name: "AI Customer Support Automation" }]), "AI Customer Support Automation");
});

test("CTAs come only from the owner's wording/destination", () => {
  assert.equal(resolveCta(base(), "primary"), "DM us to discuss what you can automate.");
  assert.equal(resolveCta(base({ ctaPhrase: undefined, primaryCta: "call", ctaDestination: undefined }), "primary"), "Send us a DM to get in touch.");
  assert.equal(resolveCta(base({ ctaPhrase: undefined, primaryCta: "visit_website", ctaDestination: "https://abc.example" }), "primary"), "Visit https://abc.example");
});

test("the plan carries objective, product, CTA and what to avoid", () => {
  const plan = planNextContent(base(), [{ content_pillar: "educational", topic: "5 repetitive tasks to automate", hook: "Still answering the same questions?", cta: "Save this post for later." }], "image");
  assert.notEqual(plan.pillar, "educational");
  assert.ok(plan.objective && plan.cta && plan.productName);
  assert.deepEqual(plan.avoid.topics, ["5 repetitive tasks to automate"]);
});

test("near-duplicate topics/hooks are detected as repeats", () => {
  const history: HistoryItem[] = [{ topic: "5 repetitive business tasks you can automate", hook: "Still answering the same customer questions every day?" }];
  assert.ok(similarity("5 repetitive business tasks that can be automated", history[0].topic!) > 0.5);
  assert.ok(repeatsHistory({ topic: "5 repetitive business tasks you can automate today" }, history));
  assert.equal(repeatsHistory({ topic: "How slow lead follow-up loses customers" }, history), null);
});

// ---- comment / DM safety --------------------------------------------------------

const reply = (over = {}) => ({ intent: "pricing_question", text: "Happy to help!", requiresHuman: false, handoffReason: "", ...over });

test("a price the business never stated is replaced, not sent", () => {
  const ctx = base({ products: [{ name: "Service" }] });
  assert.equal(unsupportedPrice("It costs $99 per month", ctx), "99");
  const d = decideReply(reply({ text: "It costs $99 per month" }), "How much?", ctx, "comment");
  assert.equal(d.action, "send");
  assert.match(d.text, /send us a DM/);
});

test("a stated price may be repeated", () => {
  const ctx = base();
  assert.equal(unsupportedPrice("Lead Follow-up Automation is $499 per month.", ctx), null);
});

test("explicit human request escalates with a fixed holding reply", () => {
  assert.ok(humanRequested("I want someone from your team to contact me."));
  assert.ok(!humanRequested("I run a dental clinic, I'm the manager"));
  const d = decideReply(reply({ text: "made up text" }), "I want someone from your team to contact me.", base(), "dm");
  assert.equal(d.requiresHuman, true);
  assert.match(d.text, /passed your message to our team/);
});

test("model-flagged complaints get the fixed holding reply and a handoff flag; spam is ignored", () => {
  const dm = decideReply(reply({ requiresHuman: true, handoffReason: "refund dispute", text: "model wording" }), "refund!", base(), "dm");
  assert.deepEqual([dm.action, dm.requiresHuman, dm.handoffReason], ["send", true, "refund dispute"]);
  assert.match(dm.text, /passed your message to our team/);
  const comment = decideReply(reply({ requiresHuman: true, text: "model wording" }), "this is bad", base(), "comment");
  assert.match(comment.text, /send us a DM/);
  assert.equal(decideReply(reply({ intent: "spam", text: "" }), "buy followers", base(), "comment").action, "ignore");
});

test("owner-forbidden phrases block a reply", () => {
  const ctx = base({ mustNotSay: "guaranteed, cheap" });
  assert.equal(restrictedPhrase("Results are guaranteed", ctx), "guaranteed");
  assert.match(validateOutbound("Very cheap!", ctx) ?? "", /restricted phrase/);
  const blocked = decideReply(reply({ text: "Results are guaranteed" }), "hi", ctx, "dm");
  assert.equal(blocked.requiresHuman, true);
  assert.doesNotMatch(blocked.text, /guaranteed/);
});

test("a normal grounded reply is sent unchanged", () => {
  const d = decideReply(reply({ intent: "general_information", text: "We automate support chats." }), "what do you do?", base(), "dm");
  assert.deepEqual([d.action, d.text, d.requiresHuman], ["send", "We automate support chats.", false]);
});

test("all purposes type-check", () => {
  const p: ContextPurpose[] = ["content", "comment", "dm", "general"];
  assert.equal(p.length, 4);
});

// ---- settings-driven schedule -----------------------------------------------------
import { weeklyItems, dueItems, parseTime, localClock, slotKey } from "../src/lib/social-schedule.ts";

test("6 posts a week leaves Sunday as a rest day; 3 spread Mon/Wed/Fri", () => {
  const six = weeklyItems({ images: 6, carousels: 0, videos: 0, stories: 0 }).map((i) => i.weekday);
  assert.deepEqual(six, [0, 1, 2, 3, 4, 5]);
  const three = weeklyItems({ images: 3, carousels: 0, videos: 0, stories: 0 }).map((i) => i.weekday);
  assert.deepEqual(three, [0, 2, 4]);
});

test("videos are spread among the posts, never bunched, and counted exactly", () => {
  const items = weeklyItems({ images: 4, carousels: 0, videos: 2, stories: 0 }).filter((i) => i.kind === "post");
  assert.equal(items.length, 6);
  assert.equal(items.filter((i) => i.format === "video").length, 2);
  const idx = items.map((i, n) => (i.format === "video" ? n : -1)).filter((n) => n >= 0);
  assert.ok(idx[1] - idx[0] >= 2, "videos should not be back to back");
});

test("times: default 17:00 posts and 19:00 stories; a preferred time moves both", () => {
  const def = weeklyItems({ images: 1, carousels: 0, videos: 0, stories: 1 });
  assert.deepEqual([def[0].minutes, def[1].minutes], [17 * 60, 19 * 60]);
  const custom = weeklyItems({ images: 1, carousels: 0, videos: 0, stories: 1, postTime: "09:30" });
  assert.deepEqual([custom[0].minutes, custom[1].minutes], [9 * 60 + 30, 11 * 60 + 30]);
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime(""), null);
});

test("more than 7 posts a week puts extra posts on the same day, hours apart", () => {
  const items = weeklyItems({ images: 10, carousels: 0, videos: 0, stories: 0 });
  const monday = items.filter((i) => i.weekday === 0);
  assert.ok(monday.length >= 2 && monday[1].minutes - monday[0].minutes === 360);
});

test("only items whose time has arrived, on the right weekday, are due", () => {
  const input = { images: 3, carousels: 0, videos: 0, stories: 3 };
  assert.equal(dueItems(input, { weekday: 0, minutes: 16 * 60 }, "post").length, 0);
  assert.equal(dueItems(input, { weekday: 0, minutes: 17 * 60 + 5 }, "post").length, 1);
  assert.equal(dueItems(input, { weekday: 1, minutes: 23 * 60 }, "post").length, 0); // Tuesday is a rest day
  assert.equal(dueItems(input, { weekday: 0, minutes: 19 * 60 }, "story").length, 1);
});

test("local clock override and slot keys are stable", () => {
  const c = localClock("Asia/Karachi", new Date(), "2026-09-28T17:05"); // a Monday
  assert.deepEqual(c, { date: "2026-09-28", weekday: 0, minutes: 17 * 60 + 5 });
  assert.equal(slotKey("post", c.date, 0), "auto_post_2026-09-28_0");
});

test("legacy: no per-format counts falls back to posts per week as images", () => {
  const items = weeklyItems({ images: 0, carousels: 0, videos: 0, stories: 0, postsPerWeek: 3 }).filter((i) => i.kind === "post");
  assert.deepEqual(items.map((i) => i.format), ["image", "image", "image"]);
});
