// Records the short "hello" once, using the SAME Gemini live model and voice as the calls, so the voice matches.
//   export GEMINI_API_KEY="..."   (optional: VOICE_GREETING_TEXT, VOICE_GEMINI_VOICE, VOICE_GEMINI_MODEL)
//   npm run voice:greeting
// Writes assets/voice-greeting.mulaw (8 kHz mu-law), which the bridge plays when the owner answers.
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { Pcm24kToMulaw } from "../src/lib/voice/audio.ts";

const URL_ = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const text = process.env.VOICE_GREETING_TEXT || "Hello! I'm just pulling up your latest numbers. One moment.";
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("Set GEMINI_API_KEY first."); process.exit(1); }

const down = new Pcm24kToMulaw();
const chunks: Buffer[] = [];
const ws = new WebSocket(URL_, { headers: { "x-goog-api-key": key } });
const timer = setTimeout(() => { console.error("Timed out."); process.exit(1); }, 30000);

ws.on("open", () => ws.send(JSON.stringify({ setup: {
  model: `models/${process.env.VOICE_GEMINI_MODEL || "gemini-2.5-flash-native-audio-latest"}`,
  generationConfig: {
    responseModalities: ["AUDIO"],
    thinkingConfig: { thinkingBudget: 0 },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.VOICE_GEMINI_VOICE || "Kore" } } },
  },
  systemInstruction: { parts: [{ text: "You are recording a short phone greeting. Say EXACTLY the sentence you are given, once, warmly and naturally, like a friendly person. Add nothing else." }] },
} })));

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.setupComplete) {
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: `Say exactly: ${text}` }] }], turnComplete: true } }));
    return;
  }
  for (const p of m.serverContent?.modelTurn?.parts ?? []) {
    if (p.inlineData?.data) chunks.push(down.convert(Buffer.from(p.inlineData.data, "base64")));
  }
  if (m.serverContent?.turnComplete) {
    clearTimeout(timer);
    const out = Buffer.concat(chunks);
    mkdirSync("assets", { recursive: true });
    writeFileSync("assets/voice-greeting.mulaw", out);
    console.log(`Saved assets/voice-greeting.mulaw (${out.length} bytes, about ${(out.length / 8000).toFixed(1)} s): "${text}"`);
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => { console.error("Gemini error: " + e.message); process.exit(1); });
