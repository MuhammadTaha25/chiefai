-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Finance approval gate for ad spend (ZERNIO_META_ADS_SPEC.md §2/§3).
--
-- ad_campaigns and ad_generation_jobs already exist live. This adds the two
-- tables the spec calls for that don't exist yet (ad_finance_decisions,
-- ad_performance) and a decide_ad_finance RPC that mirrors the existing
-- decide_budget_request pattern: a decision ORACLE only — it evaluates and
-- logs a decision but does not flip ad_campaigns.status itself. That
-- follow-through lives in src/app/api/finance/ads-decide/route.ts, same
-- split as src/app/api/finance/decide/route.ts does for budget_requests.
--
-- ad_campaigns.status has no CHECK constraint, so no migration is needed
-- there — this just adds 'pending_finance', 'approved', 'rejected',
-- 'pending_human' to the values already in play ('draft', 'launched', 'paused').

create table if not exists ad_performance (
  id uuid primary key default gen_random_uuid(),
  ad_campaign_id uuid not null references ad_campaigns(id),
  impressions bigint,
  clicks bigint,
  spend numeric,
  leads integer,
  ctr numeric,
  cpl numeric,
  is_good boolean,
  synced_at timestamptz not null default now()
);

create index if not exists ad_performance_campaign_idx on ad_performance(ad_campaign_id);

create table if not exists ad_finance_decisions (
  id uuid primary key default gen_random_uuid(),
  ad_campaign_id uuid not null references ad_campaigns(id),
  decision text not null check (decision in ('approved', 'rejected', 'pending_human')),
  reason text,
  based_on_prior_ad_id uuid references ad_campaigns(id),
  decided_at timestamptz not null default now()
);

create index if not exists ad_finance_decisions_campaign_idx on ad_finance_decisions(ad_campaign_id);

alter table ad_performance enable row level security;
alter table ad_finance_decisions enable row level security;

drop policy if exists "clients read own ad performance" on ad_performance;
create policy "clients read own ad performance"
  on ad_performance for select
  using (
    ad_campaign_id in (
      select id from ad_campaigns where client_id in (select id from clients where auth_user_id = auth.uid())
    )
  );

drop policy if exists "clients read own ad finance decisions" on ad_finance_decisions;
create policy "clients read own ad finance decisions"
  on ad_finance_decisions for select
  using (
    ad_campaign_id in (
      select id from ad_campaigns where client_id in (select id from clients where auth_user_id = auth.uid())
    )
  );

-- decide_ad_finance(p_client_id, p_ad_campaign_id):
--   * First-ever ad for the client (no other ad_campaigns rows created before
--     this one) -> auto-approved, based_on_prior_ad_id null. Nothing to
--     evaluate yet.
--   * Otherwise -> look at the client's most recent PRIOR ad_campaigns row
--     (by created_at) and its latest ad_performance.is_good:
--       is_good = true  -> approved
--       is_good = false -> rejected
--       no performance row synced yet -> pending_human (ambiguous, same as
--         decide_budget_request's third state)
--   Every call inserts one ad_finance_decisions row and logs to agent_actions
--   so the decision is auditable and can't be bypassed from the client.
create or replace function decide_ad_finance(
  p_client_id uuid,
  p_ad_campaign_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prior_ad_id uuid;
  v_is_good boolean;
  v_decision text;
  v_reason text;
begin
  select id into v_prior_ad_id
  from ad_campaigns
  where client_id = p_client_id
    and id <> p_ad_campaign_id
    and created_at < (select created_at from ad_campaigns where id = p_ad_campaign_id)
  order by created_at desc
  limit 1;

  if v_prior_ad_id is null then
    v_decision := 'approved';
    v_reason := 'First ad for this client — no prior spend/analytics to evaluate.';
  else
    select is_good into v_is_good
    from ad_performance
    where ad_campaign_id = v_prior_ad_id
    order by synced_at desc
    limit 1;

    if v_is_good is null then
      v_decision := 'pending_human';
      v_reason := format('No synced performance data yet for prior ad %s — flagged for manual Finance review.', v_prior_ad_id);
    elsif v_is_good then
      v_decision := 'approved';
      v_reason := format('Prior ad %s performed within threshold — approved.', v_prior_ad_id);
    else
      v_decision := 'rejected';
      v_reason := format('Prior ad %s performed below threshold — spend blocked.', v_prior_ad_id);
    end if;
  end if;

  insert into ad_finance_decisions (ad_campaign_id, decision, reason, based_on_prior_ad_id)
  values (p_ad_campaign_id, v_decision, v_reason, v_prior_ad_id)
  returning ad_campaign_id into p_ad_campaign_id;

  insert into agent_actions (client_id, agent_name, action, payload, result)
  values (
    p_client_id,
    'finance_decision_agent',
    'decide_ad_finance',
    jsonb_build_object('ad_campaign_id', p_ad_campaign_id, 'decision', v_decision, 'based_on_prior_ad_id', v_prior_ad_id),
    'success'
  );

  return v_decision;
end;
$$;
