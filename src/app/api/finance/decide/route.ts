import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { autoPauseAdsForDepartment } from "@/lib/ad-pause";

/**
 * decide_budget_request is a decision ORACLE only: it returns
 * 'approved' | 'declined' | 'request_human_approval', creates its own
 * budget_requests row, and logs to agent_actions — it does not update
 * that row's status, touch department_budgets, or pause anything.
 * This route does the follow-through the marketing/finance loop needs:
 * on decline, the department's budget is zeroed (the auto-pause signal
 * ad-side automation should watch for); on approval, the budget is
 * topped up by the approved amount.
 */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { department, requested_amount, current_spend, cpl, available_cash } = await req.json();

  if (!department || requested_amount == null) {
    return NextResponse.json({ error: "department and requested_amount are required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: decision, error: rpcError } = await admin.rpc("decide_budget_request", {
    p_client_id: client.id,
    p_department: department,
    p_requested_amount: requested_amount,
    p_current_spend: current_spend ?? null,
    p_cpl: cpl ?? null,
    p_available_cash: available_cash ?? null,
  });

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  // The RPC's own agent_actions log entry is the only place the new
  // budget_requests row's id is recorded — pull it back out.
  const { data: latestAction } = await admin
    .from("agent_actions")
    .select("payload")
    .eq("client_id", client.id)
    .eq("agent_name", "finance_decision_agent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const budgetRequestId = (latestAction?.payload as { budget_request_id?: string } | null)?.budget_request_id;

  let updatedRequest = null;
  let requestUpdateError: string | null = null;
  if (budgetRequestId) {
    const patch: Record<string, unknown> = { department, decided_at: new Date().toISOString() };

    if (decision === "approved") {
      patch.status = "approved";
      patch.approved_amount = requested_amount;
      patch.decision_reason = "Approved — within budget and performance thresholds.";
    } else if (decision === "declined") {
      patch.status = "declined";
      patch.approved_amount = 0;
      patch.decision_reason = "Declined — no available cash or ad performance audit failed threshold.";
    } else {
      patch.status = "pending_human";
      patch.decision_reason = "Signals ambiguous — flagged for manual Finance review.";
    }

    const { data, error } = await admin
      .from("budget_requests")
      .update(patch)
      .eq("id", budgetRequestId)
      .select()
      .maybeSingle();
    updatedRequest = data;
    requestUpdateError = error?.message ?? null;
  }

  let departmentBudget = null;
  let budgetUpdateError: string | null = null;

  if (decision === "approved" || decision === "declined") {
    const { data: existing } = await admin
      .from("department_budgets")
      .select("*")
      .eq("client_id", client.id)
      .eq("department", department)
      .maybeSingle();

    const newAmount = decision === "declined" ? 0 : (existing?.current_budget ?? 0) + Number(requested_amount);

    const { data, error } = existing
      ? await admin
          .from("department_budgets")
          .update({ current_budget: newAmount })
          .eq("id", existing.id)
          .select()
          .maybeSingle()
      : await admin
          .from("department_budgets")
          .insert({ client_id: client.id, department, current_budget: newAmount })
          .select()
          .maybeSingle();
    departmentBudget = data;
    budgetUpdateError = error?.message ?? null;
  }

  let adPauseResult: Awaited<ReturnType<typeof autoPauseAdsForDepartment>> | null = null;
  if (decision === "declined") {
    adPauseResult = await autoPauseAdsForDepartment(client.id, department);
  }

  return NextResponse.json({
    ok: !requestUpdateError && !budgetUpdateError,
    decision,
    budget_request: updatedRequest,
    department_budget: departmentBudget,
    ad_pause: adPauseResult,
    ...(requestUpdateError ? { request_update_error: requestUpdateError } : {}),
    ...(budgetUpdateError ? { budget_update_error: budgetUpdateError } : {}),
  });
}
