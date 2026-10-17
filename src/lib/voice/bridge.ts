import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { MulawToPcm16k, Pcm24kToMulaw } from "./audio.ts";

/**
 * Live voice bridge: Twilio Media Stream  <->  Gemini 2.5 native audio (Live API).
 *
 * Twilio (phone audio, 8 kHz mu-law) connects to ws://…/stream. For each call we
 * open one Gemini Live session and pipe audio both ways, converting formats in
 * ./audio. Gemini hears the caller and answers in its own voice, in whatever
 * language the caller uses, and can be interrupted mid-sentence (barge-in).
 *
 * The bridge holds NO data or credentials beyond the Gemini key and the shared
 * voice secret. Everything about the business comes from /api/voice/live on the
 * app, which verifies the signed session Twilio's TwiML minted.
 *
 * It needs a long-lived Node process (WebSockets), so it starts with `next dev`
 * / `next start` (see instrumentation.ts) and is reached through the app's own
 * origin by a rewrite. It cannot run inside Vercel serverless functions — there
 * VOICE_STREAM_URL must point at a bridge hosted elsewhere.
 */

const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MAX_CALL_MS = 10 * 60 * 1000;

export const bridgePort = () => Number(process.env.VOICE_BRIDGE_PORT || 8787);
export const liveModel = () => process.env.VOICE_GEMINI_MODEL || "gemini-2.5-flash-native-audio-latest";
const appUrl = () => (process.env.VOICE_APP_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const secret = () => process.env.VOICE_FACTS_SECRET ?? process.env.N8N_WEBHOOK_SECRET ?? "";

export function bridgeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GEMINI_API_KEY?.trim() && (env.VOICE_FACTS_SECRET ?? env.N8N_WEBHOOK_SECRET) && env.VOICE_BRIDGE !== "off");
}

async function appCall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${appUrl()}/api/voice/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-voice-secret": secret() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`app ${res.status}: ${String(json.error ?? "")}`);
  return json;
}

const TOOLS = [
  {
    functionDeclarations: [
      { name: "get_report", description: "Get the latest daily brief numbers for this business (emails sent today per mailbox, social posts and times, domains, leads, replies, deals)." },
      {
        name: "ask_company",
        description: "Answer a specific question about the owner's business using their live data.",
        parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "The owner's question, in their own words." } }, required: ["question"] },
      },
      { name: "end_call", description: "Hang up after saying goodbye, when the owner is done." },
      {
        name: "verify_pin",
        description: "Check the PIN the caller said (digits only). Only used on PIN-protected inbound calls.",
        parameters: { type: "OBJECT", properties: { pin: { type: "STRING", description: "The digits of the PIN, e.g. 482913." } }, required: ["pin"] },
      },
    ],
  },
];

/**
 * Pre-recorded hello (same Gemini voice), played the moment the owner answers so the pause while the live
 * session starts is not silent. Made once by `npm run voice:greeting`. Optional: no file, no greeting.
 */
export const greetingPath = () => process.env.VOICE_GREETING_FILE || path.join(process.cwd(), "assets", "voice-greeting.mulaw");
export function loadGreeting(file = greetingPath()): Buffer | null {
  try { return existsSync(file) ? readFileSync(file) : null; } catch { return null; }
}
/** Twilio media frames: 20 ms of 8 kHz mu-law = 160 bytes. */
export function frames(mulaw: Buffer, size = 160): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < mulaw.length; i += size) out.push(mulaw.subarray(i, Math.min(i + size, mulaw.length)));
  return out;
}
const GREETING = loadGreeting();

/** Opens the Gemini Live socket and sends the setup as soon as it is open. */
function connectGemini(session: Record<string, unknown>, pinRequired: boolean, onOpen?: () => void): WebSocket {
  const ws = new WebSocket(GEMINI_WS, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY! } });
  const send = (msg: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  ws.on("open", () => {
    onOpen?.();
    send({
      setup: {
        model: `models/${liveModel()}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          // Speed: by default the model is told not to "think" before speaking (measured: first audio ~10s -> ~2s).
          // Set VOICE_THINKING_BUDGET to a number to change it, or to "default" to leave the model's own setting.
          ...(process.env.VOICE_THINKING_BUDGET === "default"
            ? {}
            : { thinkingConfig: { thinkingBudget: Number(process.env.VOICE_THINKING_BUDGET ?? "0") || 0 } }),
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.VOICE_GEMINI_VOICE || "Kore" } } },
        },
        systemInstruction: { parts: [{ text: String(session.systemInstruction) }] },
        tools: TOOLS,
        // Normal talk: a short wait keeps replies snappy. While a PIN is being read out callers pause between digits, so wait longer.
        realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: pinRequired ? 900 : Number(process.env.VOICE_SILENCE_MS) || 500 } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  });
  return ws;
}

/** Sessions prepared while the phone rings, keyed by client. Dropped after 90 s if nobody answers. */
interface Prepared { session: Record<string, unknown>; ws: WebSocket; setupDone: boolean; reason: string; timer: NodeJS.Timeout }
const preparedCalls = new Map<string, Prepared>();

function dropPrepared(clientId: string, p?: Prepared): void {
  const cur = preparedCalls.get(clientId);
  if (!cur || (p && cur !== p)) return;
  clearTimeout(cur.timer);
  preparedCalls.delete(clientId);
  try { cur.ws.close(); } catch { /* already closed */ }
}

function takePrepared(clientId: string, reason: string): Prepared | null {
  const p = preparedCalls.get(clientId);
  if (!p) return null;
  clearTimeout(p.timer);
  preparedCalls.delete(clientId);
  const usable = p.reason === reason && (p.ws.readyState === WebSocket.OPEN || p.ws.readyState === WebSocket.CONNECTING);
  if (!usable) { try { p.ws.close(); } catch { /* already closed */ } return null; }
  return p;
}

async function prepareCall(clientId: string, reason: string, exp: number, token: string): Promise<void> {
  dropPrepared(clientId);
  const session = await appCall({ action: "start", client_id: clientId, reason, exp, token });
  const ws = connectGemini(session, session.pinRequired === true);
  const p: Prepared = { session, ws, setupDone: false, reason, timer: setTimeout(() => dropPrepared(clientId, p), 90_000) };
  p.timer.unref?.();
  ws.on("message", (raw) => { try { if (JSON.parse(raw.toString()).setupComplete) p.setupDone = true; } catch { /* ignore */ } });
  ws.on("close", () => dropPrepared(clientId, p));
  ws.on("error", () => dropPrepared(clientId, p));
  preparedCalls.set(clientId, p);
  console.log("[voice] pre-warming session while the phone rings");
}

function handlePrepare(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on("end", () => {
    if (!secret() || req.headers["x-voice-secret"] !== secret()) { res.writeHead(401).end(); return; }
    try {
      const b = JSON.parse(body) as { client_id?: string; reason?: string; exp?: number; token?: string };
      if (!b.client_id || !b.token) { res.writeHead(400).end(); return; }
      res.writeHead(202).end("ok");
      prepareCall(b.client_id, b.reason ?? "daily_report", Number(b.exp), b.token)
        .catch((e) => console.warn(`[voice] pre-warm failed (call will start normally): ${(e as Error).message}`));
    } catch { res.writeHead(400).end(); }
  });
}

interface Twilio {
  event: string;
  start?: { streamSid: string; callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string; track?: string };
}

function handleCall(twilio: WebSocket): void {
  const up = new MulawToPcm16k();
  const down = new Pcm24kToMulaw();
  let streamSid = "";
  let callSid = "";
  let clientId = "";
  let direction = "inbound";
  let gemini: WebSocket | null = null;
  let ready = false;
  let pinRequired = false;
  let verified = false;
  let wrongPins = 0;
  let endAfterTurn = false;
  let closed = false;
  const startedAt = Date.now();
  const lines: string[] = [];
  let heard = "";
  let said = "";
  const pending: Buffer[] = [];

  const flushLine = () => {
    // Before the PIN is verified the caller may be reading it out: never store that.
    if (heard.trim()) lines.push(`Owner: ${pinRequired && !verified ? "[withheld until PIN verified]" : heard.trim()}`);
    if (said.trim()) lines.push(`Agent: ${said.trim()}`);
    heard = said = "";
  };

  const finish = async () => {
    if (closed) return;
    closed = true;
    flushLine();
    try { gemini?.close(); } catch { /* already closed */ }
    try { twilio.close(); } catch { /* already closed */ }
    if (clientId) {
      await appCall({
        action: "finish", client_id: clientId, call_sid: callSid, direction,
        transcript: lines.join("\n"), duration_seconds: (Date.now() - startedAt) / 1000,
      }).catch((e) => console.warn(`[voice] could not save call: ${(e as Error).message}`));
    }
  };

  const sendToTwilio = (msg: Record<string, unknown>) => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify({ ...msg, streamSid }));
  };
  const sendGemini = (msg: Record<string, unknown>) => {
    if (gemini?.readyState === WebSocket.OPEN) gemini.send(JSON.stringify(msg));
  };

  // Timing (ms since the stream opened) so a slow start can be pinned on the right step.
  const t0 = Date.now();
  let firstAudioLogged = false;
  const mark = (what: string) => console.log(`[voice] +${Date.now() - t0}ms ${what}`);

  async function begin(params: Record<string, string>) {
    mark("stream started");
    let greeted = false;
    if (GREETING && params.reason === "daily_report") {
      for (const f of frames(GREETING)) sendToTwilio({ event: "media", media: { payload: f.toString("base64") } });
      greeted = true;
      mark("greeting sent");
    }
    clientId = params.client_id ?? "";
    const reason = params.reason ?? "inbound";
    direction = reason === "daily_report" ? "outbound" : "inbound";
    const prepared = takePrepared(clientId, reason);
    const session = prepared ? prepared.session : await appCall({ action: "start", client_id: clientId, reason, exp: Number(params.exp), token: params.token });
    mark(prepared ? "using pre-warmed session" : "app returned session");

    pinRequired = session.pinRequired === true;
    if (prepared) { gemini = prepared.ws; gemini.removeAllListeners("message"); gemini.removeAllListeners("close"); gemini.removeAllListeners("error"); }
    else gemini = connectGemini(session, pinRequired, () => mark("gemini socket open"));
    const onSetup = () => {
      mark("gemini setup complete, sending opening");
      ready = true;
      for (const b of pending.splice(0)) sendGemini({ realtimeInput: { audio: { data: b.toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
      // The agent speaks first (daily brief, or a greeting on an inbound call).
      const opening = String(session.opening) + (greeted ? " A short hello has ALREADY been played to the owner, so do NOT say hello, hi, good morning/afternoon/evening or any greeting at all: start directly with the first number, for example \"So, no emails went out today...\"." : "");
      sendGemini({ clientContent: { turns: [{ role: "user", parts: [{ text: opening }] }], turnComplete: true } });
    };

    gemini.on("message", async (raw) => {
      let m: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (m.setupComplete) { onSetup(); return; }

      const sc = m.serverContent;
      if (sc) {
        for (const p of sc.modelTurn?.parts ?? []) {
          if (p.inlineData?.data) {
            if (!firstAudioLogged) { firstAudioLogged = true; mark("FIRST AUDIO from gemini"); }
            const mulaw = down.convert(Buffer.from(p.inlineData.data, "base64"));
            if (mulaw.length) sendToTwilio({ event: "media", media: { payload: mulaw.toString("base64") } });
          }
        }
        if (sc.interrupted) sendToTwilio({ event: "clear" }); // caller barged in: drop queued speech
        if (sc.inputTranscription?.text) { if (said) flushLine(); heard += sc.inputTranscription.text; }
        if (sc.outputTranscription?.text) said += sc.outputTranscription.text;
        if (sc.turnComplete) {
          flushLine();
          if (endAfterTurn) setTimeout(() => void finish(), 2500); // let the goodbye finish playing
        }
      }

      if (m.toolCall?.functionCalls) {
        const responses = [];
        for (const fc of m.toolCall.functionCalls as { id: string; name: string; args?: Record<string, unknown> }[]) {
          let result = "";
          if (fc.name === "end_call") {
            // A stray end_call right after the greeting must not hang up on the owner.
            if (!lines.some((l) => l.startsWith("Owner:")) && !heard.trim()) result = "Not yet — the caller has not said anything. Keep the call going.";
            else { endAfterTurn = true; result = "ok"; }
          } else if (fc.name === "verify_pin") {
            // The utterance that carried the PIN must never reach the saved transcript.
            if (heard.trim()) { lines.push("Owner: [PIN attempt withheld]"); heard = ""; }
            try {
              const r = await appCall({ action: "verify_pin", client_id: clientId, pin: String(fc.args?.pin ?? "") });
              verified = r.verified === true;
              result = String(r.result ?? "");
              if (!verified && (r.locked === true || ++wrongPins >= 3)) { endAfterTurn = true; result += " Say goodbye and end the call."; }
            } catch (e) { result = "I could not check the PIN right now."; console.warn("[voice] verify_pin: " + (e as Error).message); }
          } else if (pinRequired && !verified) {
            result = "Refused: the caller has not verified the PIN.";
          } else {
            try { result = String((await appCall({ action: "tool", client_id: clientId, name: fc.name, args: fc.args ?? {} })).result ?? ""); }
            catch (e) { result = "I could not read that right now."; console.warn(`[voice] tool ${fc.name}: ${(e as Error).message}`); }
          }
          console.log(`[voice] tool ${fc.name}${fc.name === "verify_pin" ? ` -> verified=${verified}` : ""}`);
          responses.push({ id: fc.id, name: fc.name, response: { result } });
        }
        sendGemini({ toolResponse: { functionResponses: responses } });
      }
    });

    gemini.on("close", () => void finish());
    gemini.on("error", (e) => { console.warn(`[voice] gemini error: ${e.message}`); void finish(); });
    if (prepared?.setupDone) onSetup();
  }

  twilio.on("message", (raw) => {
    let m: Twilio;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.event === "start" && m.start) {
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      begin(m.start.customParameters ?? {}).catch((e) => { console.warn(`[voice] could not start: ${e.message}`); void finish(); });
      setTimeout(() => void finish(), MAX_CALL_MS).unref?.();
    } else if (m.event === "media" && m.media?.payload && m.media.track !== "outbound") {
      const pcm = up.convert(Buffer.from(m.media.payload, "base64"));
      if (ready) sendGemini({ realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
      else if (pending.length < 500) pending.push(pcm);
    } else if (m.event === "stop") {
      void finish();
    }
  });
  twilio.on("close", () => void finish());
  twilio.on("error", () => void finish());
}

/** Starts the bridge once per process. Returns false when it cannot run here. */
export function startVoiceBridge(): boolean {
  const g = globalThis as { __infomistVoiceBridge?: boolean };
  if (g.__infomistVoiceBridge) return true;
  if (process.env.VERCEL || !bridgeConfigured()) return false;
  g.__infomistVoiceBridge = true;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/prepare") { handlePrepare(req, res); return; }
    res.writeHead(200).end("infomist voice bridge");
  });
  const wss = new WebSocketServer({ server, path: "/stream" });
  wss.on("connection", handleCall);
  server.on("error", (e) => console.warn(`[voice] bridge could not listen: ${e.message}`));
  server.listen(bridgePort(), process.env.VOICE_BRIDGE_HOST || "127.0.0.1", () => console.log(`[voice] Gemini live bridge on :${bridgePort()} (${liveModel()})`));
  return true;
}
