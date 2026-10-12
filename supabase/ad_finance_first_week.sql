-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Replaces decide_ad_finance (latest version: fix_decide_ad_finance_prior_ads.sql).
--
-- New rule: a client's first launched ad starts a 7-day "first week". During
-- that week the financial audit does not run, so spend is approved without
-- judging performance. After 7 days, the audit uses the metrics of the
-- previous ad as before (a poor prior ad still blocks spend).

create or replace function decide_ad_finance(
  p_client_id uuid,
  p_ad_campaign_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first_launch timestamptz;
  v_prior_ad_id uuid;
  v_is_good boolean;
  v_decision text;
  v_reason text;
begin
  -- When the client's first ad launched (only ads that actually reached the provider count).
  select min(created_at) into v_first_launch
  from ad_campaigns
  where client_id = p_client_id
    and id <> p_ad_campaign_id
    and (zernio_campaign_id is not null or status in ('launched', 'live', 'paused'));

  select id into v_prior_ad_id
  from ad_campaigns
  where client_id = p_client_id
    and id <> p_ad_campaign_id
    and created_at < (select created_at from ad_campaigns where id = p_ad_campaign_id)
    and (zernio_campaign_id is not null or status in ('launched', 'live', 'paused'))
  order by created_at desc
  limit 1;

  if v_first_launch is not null and now() < v_first_launch + interval '7 days' then
    v_decision := 'approved';
    v_reason := format('First week of this client''s ads (started %s). Financial audit starts after 7 days.', to_char(v_first_launch, 'YYYY-MM-DD'));
  elsif v_prior_ad_id is null then
    v_decision := 'approved';
    v_reason := 'First launched ad for this client — no prior spend/analytics to evaluate.';
  else
    select is_good into v_is_good
    from ad_performance
    where ad_campaign_id = v_prior_ad_id
    order by synced_at desc
    limit 1;

    if v_is_good is null then
      v_decision := 'approved';
      v_reason := format('Prior ad %s has no synced performance data yet — nothing indicates poor performance, so spend is allowed.', v_prior_ad_id);
    elsif v_is_good then
      v_decision := 'approved';
      v_reason := format('Prior ad %s performed within threshold — approved.', v_prior_ad_id);
    else
      v_decision := 'rejected';
      v_reason := format('Prior ad %s performed below threshold — spend blocked.', v_prior_ad_id);
    end if;
  end if;

  insert into ad_finance_decisions (ad_campaign_id, decision, reason, based_on_prior_ad_id)
  values (p_ad_campaign_id, v_decision, v_reason, v_prior_ad_id);

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
