/**
 * Local QA for the business-context / strategy / comment+DM pipeline.
 * Nothing is published and nothing is written: no Zernio calls, no database.
 * Uses the real Gemini API (needs GEMINI_API_KEY in .env.local).
 *
 *   npm run qa:social            # text-only (context, strategy, captions, replies)
 *   IMAGE=1 npm run qa:social    # also renders ONE image to scratchpad/qa-image.png
 */
import * as fs from "fs";
import * as path from "path";

const root = process.cwd();
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { retrieveBusinessContext } = await import("../src/lib/business-context.ts");
  const { planNextContent } = await import("../src/lib/content-strategy.ts");
  const { createStrategicItem } = await import("../src/lib/social-content.ts");
  const { generateGroundedReply } = await import("../src/lib/social-ai.ts");
  const { decideReply } = await import("../src/lib/brand-guard.ts");
  type Ctx = import("../src/lib/business-context.ts").BusinessContext;
  type Hist = import("../src/lib/content-strategy.ts").HistoryItem;

  const dental: Ctx = {
    clientId: "dental-1",
    businessName: "Elite Dental Care",
    industry: "Dental clinic",
    description: "A family dental clinic in Lahore offering cleaning, whitening and cosmetic dentistry.",
    location: "Lahore, Pakistan",
    products: [
      { name: "Dental Cleaning", description: "Professional scale and polish", benefit: "Healthier gums and fresher breath", price: "PKR 3,000" },
      { name: "Teeth Whitening", description: "In-clinic whitening session", benefit: "A visibly brighter smile" },
      { name: "Cosmetic Dentistry", description: "Veneers and smile design", benefit: "A smile you feel confident about" },
    ],
    targetAudience: ["Adults looking for dental care"],
    painPoints: "People delay check-ups and are unsure how often to get a cleaning.",
    desiredOutcomes: "Healthy teeth and a confident smile.",
    whyChooseUs: "Gentle, modern care.",
    brandVoice: ["Friendly", "Educational"],
    primaryGoal: "bookings",
    primaryCta: "book_appointment",
    ctaPhrase: "Book your appointment today.",
    bookingMethod: "Send us a DM to book.",
    mustNotSay: "guaranteed, painless",
    language: "English",
  };
  const gym: Ctx = { clientId: "gym-1", businessName: "ABC Fitness", products: [{ name: "Personal Training" }] };

  console.log("=== 1. Context retrieval + isolation ===");
  const dm = retrieveBusinessContext(dental, { purpose: "dm", query: "how much is teeth whitening?" });
  check("mentioned product is retrieved", dm.reference.products.join() === "Teeth Whitening", dm.reference.products.join());
  check("missing price is marked NOT PROVIDED", /Teeth Whitening[^\n]*NOT PROVIDED/.test(dm.text));
  check("business B never sees business A", !retrieveBusinessContext(gym, { purpose: "comment", query: "whitening" }).text.includes("Dental"));

  console.log("\n=== 2. Strategy: pillar / objective / product / CTA rotation ===");
  const planHistory: Hist[] = [];
  const seq: string[] = [];
  for (let i = 0; i < 6; i++) {
    const plan = planNextContent(dental, planHistory, "image");
    seq.push(`${plan.pillar} (${plan.productName})`);
    planHistory.unshift({ content_pillar: plan.pillar, product_name: plan.productName, cta: plan.cta });
  }
  console.log("  " + seq.join("\n  "));
  check("no two consecutive posts share a pillar", seq.every((s, i) => i === 0 || s.split(" ")[0] !== seq[i - 1].split(" ")[0]));
  check("no trust posts without provided proof", !seq.some((s) => s.startsWith("trust")));

  console.log("\n=== 3. Real Gemini: content for Elite Dental Care (image, video, story) ===");
  const hist: Hist[] = [];
  const img = await createStrategicItem({ ctx: dental, history: hist, format: "image", forcePillar: "educational" });
  console.log(
    `  IMAGE  pillar=${img.plan.pillar} objective=${img.plan.objective} product=${img.plan.productName}\n  topic: ${img.draft.topic}\n  hook: ${img.draft.hook}\n  cta: ${img.plan.cta}\n  hashtags: ${img.draft.hashtags.join(" ")}\n  caption:\n${img.caption
      .split("\n")
      .map((l) => "    " + l)
      .join("\n")}`
  );
  check("image caption contains the CTA", img.caption.toLowerCase().includes(img.plan.cta.toLowerCase().slice(0, 20)));
  check("image has hashtags and an image prompt", img.draft.hashtags.length >= 3 && img.draft.imagePrompt.length > 20);
  check("caption avoids the owner's forbidden words", !/guaranteed|painless/i.test(img.caption));

  hist.unshift({ content_pillar: img.plan.pillar, topic: img.draft.topic, hook: img.draft.hook, cta: img.plan.cta, caption: img.caption, product_name: img.plan.productName });
  const vid = await createStrategicItem({ ctx: dental, history: hist, format: "video" });
  console.log(`\n  VIDEO  pillar=${vid.plan.pillar} objective=${vid.plan.objective}\n  topic: ${vid.draft.topic}\n  hook: ${vid.draft.hook}\n  video prompt: ${vid.draft.videoPrompt.slice(0, 160)}...`);
  check("video has a scene prompt", vid.draft.videoPrompt.length > 20);
  check("video differs from the image in pillar and topic", vid.plan.pillar !== img.plan.pillar && vid.draft.topic !== img.draft.topic);

  const story = await createStrategicItem({
    ctx: dental,
    history: hist,
    format: "story",
    supports: { ...hist[0], topic: img.draft.topic, hook: img.draft.hook, caption: img.caption },
  });
  console.log(`\n  STORY  teaser: ${story.draft.caption}\n  story image prompt: ${story.draft.storyImagePrompt.slice(0, 160)}...`);
  check("story has its own 9:16 prompt, not the feed prompt", story.draft.storyImagePrompt.length > 20 && story.draft.storyImagePrompt !== img.draft.imagePrompt);

  console.log("\n=== 4. Real Gemini: comments and DMs (grounded reply + safety layer) ===");
  async function ask(type: "comment" | "dm", text: string, conversation?: { role: "customer" | "us"; text: string }[]) {
    const retrieved = retrieveBusinessContext(dental, { purpose: type, query: text });
    const draft = await generateGroundedReply({
      senderCompany: "Elite Dental Care",
      platform: "instagram",
      messageType: type,
      theirMessage: text,
      businessContext: retrieved.text,
      conversation,
    });
    const d = decideReply(draft, text, dental, type);
    console.log(`  ${type.toUpperCase()}: "${text}"\n    intent=${d.intent} action=${d.action} requires_human=${d.requiresHuman}${d.handoffReason ? ` (${d.handoffReason})` : ""}\n    reply: ${d.text || "(none)"}`);
    return d;
  }

  const price = await ask("comment", "How much does teeth whitening cost?");
  check("no price invented when none is provided", !/\d/.test(price.text), price.text);
  const stated = await ask("dm", "what's the price for a dental cleaning?");
  check("stated price is used", /3,?000/.test(stated.text), stated.text);
  const human = await ask("dm", "I want someone from your team to contact me.");
  check("explicit human request escalates", human.requiresHuman);
  const unknown = await ask("comment", "Do you accept Bitcoin payments?");
  check("undocumented question is not confirmed", !/\b(yes|absolutely|we do accept)\b/i.test(unknown.text), unknown.text);
  const positive = await ask("comment", "Looks great!");
  check("positive comment gets a reply without escalation", positive.action === "send" && !positive.requiresHuman);
  const angry = await ask("dm", "This is terrible, I want a refund right now!");
  check("angry refund message goes to a human", angry.requiresHuman);

  console.log("\n=== 5. DM memory ===");
  const memory = await ask("dm", "Mostly whitening. What do you suggest?", [
    { role: "customer", text: "Hi, I'm looking to improve my smile before my wedding." },
    { role: "us", text: "Congratulations! Which treatment are you most interested in?" },
  ]);
  check("reply reflects the earlier turns (wedding/smile/whitening)", /wedding|smile|whiten|bright/i.test(memory.text), memory.text);

  if (process.env.IMAGE === "1") {
    console.log("\n=== 6. Real image render ===");
    const { generateSocialImage } = await import("../src/lib/gemini.ts");
    const out = await generateSocialImage(img.draft.imagePrompt.slice(0, 1200), "1:1");
    const file = path.join(root, "scratchpad", "qa-image.png");
    fs.writeFileSync(file, Buffer.from(out.base64, "base64"));
    check("image generated", true, file);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
