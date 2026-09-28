-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- budget_requests is missing columns the Finance UI and decide_budget_request RPC
-- both depend on: department (required arg to the RPC), approved_amount, decision_reason.
-- Confirmed missing via the live OpenAPI schema, not assumed.

alter table budget_requests
  add column if not exists department text,
  add column if not exists approved_amount numeric,
  add column if not exists decision_reason text;

-- department is required by decide_budget_request's p_department argument —
-- enforce it going forward once any existing rows (if any) are backfilled.
-- Check first whether backfill is needed:
select id, department from budget_requests where department is null;

-- Only run this once the above returns no rows (or after backfilling them):
-- alter table budget_requests alter column department set not null;
