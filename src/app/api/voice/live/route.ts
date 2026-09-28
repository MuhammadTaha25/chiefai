import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanyFacts } from "@/lib/company-facts";
import { answerCompanyQuestion } from "@/lib/gemini";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { getCallSettings } from "@/lib/voice/call-settings";
import { spokenSummary } from "@/lib/voice/report";
import { verifySessionToken, voiceSecret } from "@/lib/voice/session-token";
import { logEvent } from "@/lib/log-event";
import { checkPin, getPinHash, normalisePin, pinLocked, recordPinResult } from "@/lib/voice/pin";

/**
 * Control plane for the live Gemini voice bridge (src/lib/voice/bridge.ts).
 *
 *  start  -> verify the signed session, return the agent's instructions
 *  tool   -> run a function the model called (report / question)
 *  finish -> store the transcript
 *
 * Auth: the bridge presents x-voice-secret, AND `start` needs the token our own
 * TwiML endpoint minted after verifying Twilio's signature. After `start` the
 * bridge holds the tenant id; it is never taken from anything the caller says.
 */

function instruction(business: string, report: string | null, reason: string, tz: string): string {
  const outbound = reason === "daily_report";
  const locked = report === null; // inbound call on a PIN-protected line
  return [
    `You are the voice assistant of ${business}, speaking to its owner/CEO on the phone. Be warm, brief and natural — this is a phone call, not an essay.`,
    `LANGUAGE: reply in whatever language the person speaks — English, Urdu, Hindi, Arabic, or a natural mix such as Roman-Urdu with English business words. Switch when they switch. Numbers and names may stay in English.`,
    `ACCURACY: only state figures that appear in REPORT below or that a tool returns. If something is not in them, say you do not have it. Never invent numbers, and never guess ad spend or ROI.`,
    locked
      ? `SECURITY: this line is PIN-protected. You currently know NOTHING about the business and must not say anything about it. Greet briefly and ask them to SAY their PIN out loud (a spoken PIN, not keypad digits). Callers often say a PIN in pieces or pause between digits, so wait until they have clearly finished. NEVER decide yourself whether a PIN is correct, valid or too short: as soon as they have said digits, ALWAYS call verify_pin with exactly the digits you heard (digits only, e.g. 6517) and tell them the result it returns. If they gave fewer than 4 digits and stop, still call verify_pin. If it is wrong, say so and let them try again; never hint at the PIN. Until verify_pin succeeds, refuse every other request. After it succeeds you receive the report, then help them.`
      : outbound
      ? `This is the scheduled DAILY BRIEF call. Greet them in one short line, then read the report in a spoken, human way — lead with today's emails (and which mailboxes sent them), social posts and their times, domains, then leads, replies and deals. Skip nothing that is in the report, but do not read it like a list of numbers. Then ask if they want details on anything.`
      : `The owner has called you. Greet them in one short line and ask what they would like to know. Offer the daily brief if they want an overview.`,
    `If they ask something the report does not cover, call ask_company. To refresh the numbers, call get_report. When they say goodbye or have nothing else, say a short goodbye and call end_call.`,
    `Owner's timezone: ${tz}. Right now it is ${new Date().toLocaleString("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" })} for them — greet to match (say good morning only in the morning, good afternoon or good evening otherwise).`,
    `TIMES: every clock time in REPORT is already in the owner's timezone. Read each time exactly as written, including AM/PM, and never convert, shift or round it. If several posts have different times, say each one or say "between X and Y" using the exact first and last times.`,
    locked ? "" : `REPORT (${new Date().toISOString()}):\n${report}`,
  ].join("\n\n");
}

export async function POST(req: NextRequest) {
  if (!voiceSecret()) return NextResponse.json({ error: "Voice is not configured" }, { status: 503 });
  if (req.headers.get("x-voice-secret") !== voiceSecret()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "Malformed body" }, { status: 400 });

  const admin = createAdminClient();
  const clientId = String(body.client_id ?? "");

  try {
    if (body.action === "start") {
      const reason = String(body.reason ?? "inbound");
      if (!verifySessionToken(clientId, reason, Number(body.exp), String(body.token ?? ""))) {
        logEvent("voice.live", { result: "bad_token" });
        return NextResponse.json({ error: "Invalid session" }, { status: 401 });
      }
      const settings = await getCallSettings(admin, clientId);
      const [facts, ctx] = await Promise.all([getCompanyFacts(admin, clientId, settings.daily_call_timezone), getClientBusinessContext(admin, clientId)]);
      const business = ctx.businessName ?? "your business";
      // Inbound + PIN set: hold the report back entirely until the PIN is verified.
      const pinRequired = reason !== "daily_report" && Boolean(await getPinHash(admin, clientId));
      logEvent("voice.live", { client_id: clientId, result: "start", reason, pin: pinRequired });
      return NextResponse.json({
        ok: true,
        reason,
        pinRequired,
        opening: pinRequired
          ? "The call just connected. Greet the caller briefly and ask for the PIN."
          : reason === "daily_report"
            ? "The call just connected. Greet the owner and give the daily brief now."
            : "The call just connected. Greet the owner and ask how you can help.",
        systemInstruction: instruction(business, pinRequired ? null : spokenSummary(business, facts), reason, settings.daily_call_timezone),
      });
    }

    // Everything below needs a tenant the bridge got from a verified `start`.
    if (!clientId) return NextResponse.json({ error: "client_id required" }, { status: 400 });

    if (body.action === "verify_pin") {
      if (pinLocked(clientId)) return NextResponse.json({ ok: true, verified: false, locked: true, result: "Too many wrong attempts. This line is locked for 15 minutes." });
      const pin = normalisePin(String(body.pin ?? "").replace(/\D/g, ""));
      const stored = await getPinHash(admin, clientId);
      const ok = Boolean(pin && stored && checkPin(pin, stored));
      recordPinResult(clientId, ok);
      logEvent("voice.live", { client_id: clientId, result: ok ? "pin_ok" : "pin_wrong" });
      if (!ok) return NextResponse.json({ ok: true, verified: false, result: "That PIN is not correct." });
      const settings = await getCallSettings(admin, clientId);
      const [facts, ctx] = await Promise.all([getCompanyFacts(admin, clientId, settings.daily_call_timezone), getClientBusinessContext(admin, clientId)]);
      return NextResponse.json({ ok: true, verified: true, result: "PIN verified. REPORT:\n" + spokenSummary(ctx.businessName ?? "your business", facts) });
    }

    if (body.action === "tool") {
      const settings = await getCallSettings(admin, clientId);
      const facts = await getCompanyFacts(admin, clientId, settings.daily_call_timezone);
      const ctx = await getClientBusinessContext(admin, clientId);
      if (body.name === "get_report") {
        return NextResponse.json({ ok: true, result: spokenSummary(ctx.businessName ?? "your business", facts) });
      }
      if (body.name === "ask_company") {
        const question = String(body.args?.question ?? "").slice(0, 500);
        if (!question) return NextResponse.json({ ok: true, result: "No question was given." });
        const { answer } = await answerCompanyQuestion({ question, facts, businessContext: formatBusinessContext(ctx) });
        return NextResponse.json({ ok: true, result: answer });
      }
      return NextResponse.json({ ok: true, result: "Unknown tool." });
    }

    if (body.action === "finish") {
      const callSid = String(body.call_sid ?? "");
      const row = {
        transcript: String(body.transcript ?? "").slice(0, 20000) || null,
        duration_seconds: Number.isFinite(Number(body.duration_seconds)) ? Math.round(Number(body.duration_seconds)) : null,
      };
      // The daily-call cron already inserted a row for this call SID.
      const upd = callSid ? await admin.from("client_calls").update(row).eq("client_id", clientId).eq("call_sid", callSid).select("id") : null;
      if (!upd?.data?.length) {
        await admin.from("client_calls").insert({ client_id: clientId, call_sid: callSid || null, direction: body.direction === "outbound" ? "outbound" : "inbound", ...row });
      }
      logEvent("voice.live", { client_id: clientId, result: "finished", seconds: row.duration_seconds });
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    logEvent("voice.live", { client_id: clientId, result: "failed", action: body.action, error: (err as Error).message });
    return NextResponse.json({ error: "Could not complete the request." }, { status: 502 });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
