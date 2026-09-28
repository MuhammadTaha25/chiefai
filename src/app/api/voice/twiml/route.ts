import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanyFacts } from "@/lib/company-facts";
import { answerCompanyQuestion } from "@/lib/gemini";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { resolveClientByCalledNumber } from "@/lib/voice/provision";
import { spokenSummary, xml } from "@/lib/voice/report";
import { unsignedWebhooksAllowed } from "@/lib/webhook-security";
import { logEvent } from "@/lib/log-event";
import { getCallSettings } from "@/lib/voice/call-settings";
import { bridgeConfigured } from "@/lib/voice/bridge";
import { getPinHash } from "@/lib/voice/pin";
import { mintSessionToken } from "@/lib/voice/session-token";

/**
 * Our own voice app (TwiML).
 *
 * This is what actually answers a call when ElevenLabs is not in the path —
 * there is no ELEVENLABS_API_KEY in this environment, so a freshly bought
 * number would otherwise ring and say nothing. Twilio posts here, we read the
 * tenant's numbers, speak the report, and then listen for a question.
 *
 * It deliberately goes through the SAME tenant rule as the rest of voice: the
 * number that was DIALED decides whose figures are read. `client_id` in the
 * query string is only a hint used for the outbound call we ourselves placed;
 * it is never trusted, and the dialled number always wins.
 *
 * Auth: Twilio request signature (X-Twilio-Signature, HMAC-SHA1 over the URL and
 * the sorted parameters, keyed by the auth token). That is the standard way to
 * prove a request really came from Twilio — the caller cannot forge it.
 */

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL ?? "").replace(/\/$/, "");

/** Turns taken before we stop listening and hang up, so a call cannot run forever. */
const MAX_TURNS = 5;

function signatureValid(url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!TWILIO_AUTH_TOKEN) return false;
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", TWILIO_AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Every reply is TwiML; a failure must still speak rather than hang up silently. */
function twiml(inner: string, status = 200) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Caller-ID match against the owner's saved mobile (VOICE_ALLOW_ANY_CALLER=true switches the check off). */
function callerAllowed(from: string, owner: string | null): boolean {
  if (process.env.VOICE_ALLOW_ANY_CALLER === "true") return true;
  return Boolean(owner && from && digits(from) === digits(owner));
}

function streamUrl(): string {
  return process.env.VOICE_STREAM_URL?.trim() || `${PUBLIC_APP_URL.replace(/^http/, "ws")}/api/voice/stream`;
}

const actionUrl = (turn: number) => `${PUBLIC_APP_URL}/api/voice/twiml?turn=${turn}`;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(raw));

  // Twilio signs the exact URL it called, including our own query string.
  const signedUrl = `${PUBLIC_APP_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const ok = signatureValid(signedUrl, params, req.headers.get("x-twilio-signature")) || unsignedWebhooksAllowed();
  if (!ok) {
    logEvent("voice.twiml", { result: "bad_signature" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const to = params.To ?? "";
  const from = params.From ?? "";
  const speech = (params.SpeechResult ?? "").trim();
  const turn = Number(req.nextUrl.searchParams.get("turn") ?? "0") || 0;

  const admin = createAdminClient();

  // The DIALED number always wins. For an inbound call that is `To`; for the
  // outbound report call we placed, it is `From` (our own number).
  let clientId: string | null = null;
  for (const candidate of [to, from]) {
    if (!candidate) continue;
    clientId = await resolveClientByCalledNumber(admin, candidate);
    if (clientId) break;
  }

  if (!clientId) {
    logEvent("voice.twiml", { result: "unmatched_number", to, from });
    return twiml(`<Say voice="Polly.Joanna">Sorry, this number is not linked to an account yet. Goodbye.</Say><Hangup/>`);
  }

  // Who is on the line? The daily-brief call is one we placed ourselves (the
  // signed URL proves it). For an inbound call only the owner's own mobile may
  // hear the business's numbers — anyone else who dials the line gets nothing.
  const settings = await getCallSettings(admin, clientId).catch(() => null);
  const outbound = (params.Direction ?? "").startsWith("outbound");
  const pinSet = Boolean(await getPinHash(admin, clientId).catch(() => null));
  if (!outbound && !pinSet && !callerAllowed(from, settings?.personal_phone_number ?? null)) {
    logEvent("voice.twiml", { client_id: clientId, result: "caller_not_owner" });
    return twiml(`<Say voice="Polly.Joanna">This line is private. If you are the owner, save your mobile number in the Phone page of your dashboard and call again. Goodbye.</Say><Hangup/>`);
  }

  // Preferred path: live Gemini native audio (multilingual, interruptible).
  if (bridgeConfigured() && !speech && turn === 0) {
    const reason = outbound ? "daily_report" : "inbound";
    const { exp, token } = mintSessionToken(clientId, reason);
    logEvent("voice.twiml", { client_id: clientId, result: "stream", reason });
    return twiml(
      `<Connect><Stream url="${xml(streamUrl())}">` +
        `<Parameter name="client_id" value="${xml(clientId)}"/><Parameter name="reason" value="${reason}"/>` +
        `<Parameter name="exp" value="${exp}"/><Parameter name="token" value="${token}"/>` +
        `</Stream></Connect>` +
        // Only reached if the live stream ends abnormally: say so instead of a silent drop.
        `<Say voice="Polly.Joanna">Sorry, the connection was lost. Please call again in a moment.</Say><Hangup/>`
    );
  }

  try {
    const ctx = await getClientBusinessContext(admin, clientId);
    const business = ctx.businessName ?? "your business";

    // A question was spoken — answer it, then keep listening.
    if (speech) {
      const facts = await getCompanyFacts(admin, clientId, settings?.daily_call_timezone);
      const { answer } = await answerCompanyQuestion({
        question: speech.slice(0, 500),
        facts,
        businessContext: formatBusinessContext(ctx),
      });
      logEvent("voice.twiml", { client_id: clientId, result: "answered", turn });

      if (turn >= MAX_TURNS) {
        return twiml(`<Say voice="Polly.Joanna">${xml(answer)}</Say><Say voice="Polly.Joanna">That is everything for now. Goodbye.</Say><Hangup/>`);
      }
      return twiml(
        `<Say voice="Polly.Joanna">${xml(answer)}</Say>` +
          `<Gather input="speech" speechTimeout="auto" action="${xml(actionUrl(turn + 1))}" method="POST">` +
          `<Say voice="Polly.Joanna">Anything else?</Say>` +
          `</Gather>` +
          `<Say voice="Polly.Joanna">Goodbye.</Say><Hangup/>`
      );
    }

    // First turn — speak the report and start listening.
    const facts = await getCompanyFacts(admin, clientId, settings?.daily_call_timezone);
    const report = spokenSummary(business, facts);
    logEvent("voice.twiml", { client_id: clientId, result: "report_spoken", turn });

    return twiml(
      `<Say voice="Polly.Joanna">${xml(report)}</Say>` +
        `<Gather input="speech" speechTimeout="auto" action="${xml(actionUrl(1))}" method="POST">` +
        `<Say voice="Polly.Joanna">You can ask me anything about your business.</Say>` +
        `</Gather>` +
        `<Say voice="Polly.Joanna">Goodbye.</Say><Hangup/>`
    );
  } catch (err) {
    logEvent("voice.twiml", { client_id: clientId, result: "failed", error: (err as Error).message });
    return twiml(`<Say voice="Polly.Joanna">Sorry, I could not read your report right now. Please try again later.</Say><Hangup/>`);
  }
}

/** Twilio may probe with GET; answer politely rather than 405. */
export async function GET() {
  return twiml(`<Say voice="Polly.Joanna">This number is answered by your Infomist assistant. Please call back.</Say><Hangup/>`);
}
