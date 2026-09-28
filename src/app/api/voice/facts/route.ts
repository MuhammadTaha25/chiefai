import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanyFacts } from "@/lib/company-facts";
import { answerCompanyQuestion } from "@/lib/gemini";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { resolveClientByCalledNumber } from "@/lib/voice/provision";
import { spokenSummary } from "@/lib/voice/report";
import { logEvent } from "@/lib/log-event";

/**
 * The voice agent's data tool.
 *
 * This is the piece that was missing: the app could BUY a phone number, but
 * nothing could answer a question once the owner actually rang it. The voice
 * agent (ElevenLabs, or our own TwiML app) calls this endpoint and reads the
 * `spoken` field back to the caller.
 *
 * Tenant resolution is the whole security story here. The caller is on a phone
 * — there is no session — so the ONLY thing that may decide which business's
 * numbers get read is the number they dialled, resolved through
 * `client_phone_numbers` (server-side). A caller can never ask for another
 * tenant's data by naming one, because we never read a client id from the
 * request body.
 *
 * Auth is a shared secret the voice provider presents (`x-voice-secret`), not a
 * user session: this endpoint is called by ElevenLabs/n8n, not a browser.
 * It fails closed when the secret is not configured.
 */

const SHARED_SECRET = process.env.VOICE_FACTS_SECRET ?? process.env.N8N_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  if (!SHARED_SECRET) {
    return NextResponse.json({ error: "Voice facts endpoint is not configured" }, { status: 503 });
  }
  const presented = req.headers.get("x-voice-secret") ?? req.headers.get("x-webhook-secret");
  if (presented !== SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  // Twilio/ElevenLabs send the dialled number under a few different names
  // depending on the flow — accept the known ones, never a client id.
  const calledNumber =
    body.called_number ?? body.calledNumber ?? body.to ?? body.To ?? body.phone_number ?? body.phoneNumber;
  if (typeof calledNumber !== "string" || !calledNumber.trim()) {
    return NextResponse.json({ error: "called_number is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const clientId = await resolveClientByCalledNumber(admin, calledNumber);
  if (!clientId) {
    // The agent should say something helpful rather than read another tenant's
    // numbers — an unknown dialled number resolves to nobody, by design.
    return NextResponse.json({
      ok: true,
      client_id: null,
      spoken: "Sorry, this number is not linked to an account yet, so I cannot read any reports for it.",
    });
  }

  const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
  const intent = question ? "question" : "summary";

  try {
    const [facts, ctx] = await Promise.all([getCompanyFacts(admin, clientId), getClientBusinessContext(admin, clientId)]);
    const business = ctx.businessName ?? "your business";

    if (intent === "summary") {
      logEvent("voice.facts", { client_id: clientId, intent, result: "summary" });
      return NextResponse.json({
        ok: true,
        client_id: clientId,
        intent,
        spoken: spokenSummary(business, facts),
        business: { name: ctx.businessName ?? null, industry: ctx.industry ?? null },
      });
    }

    const { answer } = await answerCompanyQuestion({
      question,
      facts,
      businessContext: formatBusinessContext(ctx),
    });
    logEvent("voice.facts", { client_id: clientId, intent, result: "answered" });
    return NextResponse.json({
      ok: true,
      client_id: clientId,
      intent,
      spoken: answer,
      business: { name: ctx.businessName ?? null, industry: ctx.industry ?? null },
    });
  } catch (err) {
    logEvent("voice.facts", { client_id: clientId, intent, result: "failed", error: (err as Error).message });
    return NextResponse.json({ error: "Could not read the report right now." }, { status: 502 });
  }
}
