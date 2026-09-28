import * as fs from "fs";
import * as path from "path";

const envPath = path.resolve(__dirname, "..", ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim();
}

let pass = 0;
let fail = 0;

function report(label: string, expected: string, actual: string) {
  const ok = expected === actual;
  if (ok) pass++;
  else fail++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label} -> got "${actual}", expected "${expected}"`);
}

async function main() {
  const { classifyReply, draftReplyEmail, draftFollowUpEmail, draftAidaEmail } = await import("../src/lib/gemini");
  const { isUnsubscribeRequest } = await import("../src/lib/compliance");

  console.log("=== 1. Reply classification, 4-way (core cases) ===");
  const coreCases: { text: string; expect: string }[] = [
    { text: "Thanks, this looks interesting. I'd love to learn more.", expect: "HAPPY" },
    { text: "Yes, let's schedule a call. Send me your calendar.", expect: "BOOKING" },
    { text: "Stop emailing me. I am not interested.", expect: "ANGRY" },
    { text: "Can you send me some more information?", expect: "UNCLEAR" },
  ];
  for (const c of coreCases) {
    report(c.text.slice(0, 45), c.expect, (await classifyReply(c.text)).classification);
  }

  console.log("\n=== 1b. Reply classification (ambiguous cases — logged, not strict-graded) ===");
  const ambiguousCases = [
    { label: "E. Positive but not booking", text: "This is exactly what we need, great work!" },
    { label: "F. Booking intent without word 'book'", text: "I'm free Thursday afternoon if you want to walk me through it." },
    { label: "G. Negative but polite", text: "Thanks, but this isn't a priority for us right now." },
    { label: "H. Unsubscribe request", text: "Please unsubscribe me from this list." },
    { label: "I. Question about pricing", text: "What does this cost per month?" },
    { label: "J. Out-of-office reply", text: "I am currently out of office until Monday and will respond when I return." },
    { label: "K. Automated email", text: "This is an automated delivery failure notification. Your message could not be delivered." },
    { label: "L. Very short reply", text: "ok" },
    { label: "M. Not now, maybe later", text: "Not now, maybe reach out again in a few months." },
  ];
  for (const c of ambiguousCases) {
    const result = await classifyReply(c.text);
    console.log(`  ${c.label}: "${c.text.slice(0, 50)}" -> ${result.classification} (confidence ${result.confidence}) — ${result.reason}`);
  }

  console.log("\n=== 2. Unsubscribe detection (deterministic, non-AI) ===");
  const unsubscribeCases = [
    { text: "unsubscribe", expect: true },
    { text: "Please remove me from this list", expect: true },
    { text: "Stop emailing me", expect: true },
    { text: "don't contact me again", expect: true },
    { text: "take me off your list", expect: true },
    { text: "What does this cost?", expect: false },
    { text: "Sounds great, let's talk", expect: false },
  ];
  for (const c of unsubscribeCases) {
    report(`isUnsubscribeRequest("${c.text}")`, String(c.expect), String(isUnsubscribeRequest(c.text)));
  }

  console.log("\n=== 3. Tone-adapted replies (spot-check length + no crash) ===");
  for (const sentiment of ["ANGRY", "HAPPY", "BOOKING", "UNCLEAR"] as const) {
    const draft = await draftReplyEmail({
      sentiment,
      senderCompany: "Infomist",
      leadName: "Alex",
      theirReply: sentiment === "ANGRY" ? "Stop emailing me." : "Sounds interesting, tell me more.",
      calendlyUrl: "https://calendly.com/infomist/demo",
    });
    const hasSubjectAndBody = Boolean(draft.subject && draft.body);
    console.log(`  [${sentiment}] subject="${draft.subject}" bodyLen=${draft.body.length} ${hasSubjectAndBody ? "OK" : "MISSING FIELDS"}`);
  }

  console.log("\n=== 4. Follow-up email (word count check) ===");
  const followUp = await draftFollowUpEmail({
    sellingDescription: "AI-powered outreach automation for B2B sales teams",
    senderCompany: "Infomist",
    leadName: "Jordan",
    leadCompany: "Acme Corp",
    followUpNumber: 2,
  });
  const wordCount = followUp.body.split(/\s+/).filter(Boolean).length;
  console.log(`  subject="${followUp.subject}" wordCount=${wordCount} ${wordCount <= 80 ? "OK (roughly under limit)" : "OVER LIMIT"}`);

  console.log("\n=== 5. AIDA cold email ===");
  const aida = await draftAidaEmail({
    sellingDescription: "AI-powered outreach automation for B2B sales teams",
    senderCompany: "Infomist",
    leadName: "Sam",
    leadCompany: "Beta Inc",
    leadTitle: "VP Sales",
  });
  console.log(`  subject="${aida.subject}"`);
  console.log(`  body: ${aida.body}`);

  console.log("\n=== 6. Error handling: classifyReply never crashes / always falls back to UNCLEAR ===");
  const realFetch = global.fetch;

  // 6a. Network failure
  global.fetch = (() => Promise.reject(new Error("simulated network failure"))) as typeof fetch;
  report("classifyReply on network failure", "UNCLEAR", (await classifyReply("Sounds good, let's talk")).classification);

  // 6b. Non-2xx response (e.g. 429 rate-limit / 401 invalid key)
  global.fetch = (() =>
    Promise.resolve(new Response("rate limited", { status: 429 }))) as typeof fetch;
  report("classifyReply on 429 rate-limit", "UNCLEAR", (await classifyReply("Sounds good, let's talk")).classification);

  // 6c. Malformed JSON in the response body
  global.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not valid json {{{" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )) as typeof fetch;
  report("classifyReply on malformed JSON", "UNCLEAR", (await classifyReply("Sounds good, let's talk")).classification);

  // 6d. Empty response (no candidates)
  global.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ candidates: [] }), { status: 200 }))) as typeof fetch;
  report("classifyReply on empty response", "UNCLEAR", (await classifyReply("Sounds good, let's talk")).classification);

  // 6e. Valid JSON but unexpected classification value
  global.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"classification":"ecstatic","confidence":0.5,"reason":"x"}' }] } }] }),
        { status: 200 }
      )
    )) as typeof fetch;
  report(
    "classifyReply on unexpected classification value",
    "UNCLEAR",
    (await classifyReply("Sounds good, let's talk")).classification
  );

  global.fetch = realFetch;

  console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed (core/deterministic checks only) ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
