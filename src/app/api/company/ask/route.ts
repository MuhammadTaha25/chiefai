import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCompanyFacts } from "@/lib/company-facts";
import { answerCompanyQuestion } from "@/lib/gemini";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { logEvent } from "@/lib/log-event";

/**
 * "Ask your company", handled fully in-app (previously the inactive n8n
 * chief-of-staff-query workflow). The tenant comes from the session only, and
 * the model sees just that tenant's aggregate facts.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { question?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Missing question" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "Question is too long (max 500 characters)" }, { status: 400 });

  const admin = createAdminClient();
  try {
    const [facts, ctx] = await Promise.all([getCompanyFacts(admin, client.id), getClientBusinessContext(admin, client.id)]);
    const { answer } = await answerCompanyQuestion({ question, facts, businessContext: formatBusinessContext(ctx) });
    logEvent("company.ask", { client_id: client.id, result: "answered" });
    return NextResponse.json({ ok: true, answer });
  } catch (err) {
    logEvent("company.ask", { client_id: client.id, result: "failed", error: (err as Error).message });
    return NextResponse.json({ error: "Could not answer right now. Please try again." }, { status: 502 });
  }
}
