-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Replaces decide_ad_finance (originally in ad_finance_ledger.sql).
--
-- Two real bugs were making the gate either meaningless or permanently stuck:
--
--   1. It evaluated the client's most recent PRIOR ad_campaigns row of ANY
--      status. A row left over from a failed/duplicate/never-launched attempt
--      ("error", "generating", "declined", "pending_human") has no spend and no
--      analytics — it must not gate anything. Only ads that actually reached
--      the provider count as "the previous ad".
--
--   2. When that prior ad HAD launched but no ad_performance row had synced
--      yet (normal for the first hours, and permanently true before the ads
--      sync cron wrote performance), the gate returned 'pending_human' — so
--      every ad after the first was held forever and could never go live.
--      Absent data is not bad data: it is now approved and the reason says so.
--      The block the spec actually asked for — prior ad performed BADLY — is
--      unchanged and still rejects the spend.
--
-- The decision is still an oracle: it evaluates and logs, and the calling route
-- is what flips ad_campaigns.status.

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
  -- Only a prior ad that actually launched (has a provider campaign id, or a
  -- launched/live/paused status) is a real precedent to judge against.
  select id into v_prior_ad_id
  from ad_campaigns
  where client_id = p_client_id
    and id <> p_ad_campaign_id
    and created_at < (select created_at from ad_campaigns where id = p_ad_campaign_id)
    and (zernio_campaign_id is not null or status in ('launched', 'live', 'paused'))
  order by created_at desc
  limit 1;

  if v_prior_ad_id is null then
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
