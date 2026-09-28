-- ONE-SHOT: paste this whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Project timfpxablcdgwrkucrjj. Idempotent (add column if not exists / create or replace) - safe to run twice.

-- 1/3 add_ad_launch_details.sql
-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
--
-- Records the FULL Meta hierarchy a live ad is made of, so the app can prove
-- what it launched instead of only storing one campaign id:
--
--   ad_campaigns.zernio_campaign_id  -> Meta campaign  (objective / budget model)
--   ad_campaigns.ad_set_id           -> Meta ad set    (budget, geo, age, gender, placements, optimization)
--   ad_campaigns.ad_id               -> Meta ad        (creative + delivery)
--   ad_campaigns.creative_id         -> Meta creative
--   ad_campaigns.image_url           -> the AI-generated image attached to the ad
--   ad_campaigns.targeting           -> exactly what we sent, for auditing a spend decision
--   ad_campaigns.launch_payload      -> notes/warnings shown to the user after launch
--   ad_campaigns.reach_estimate      -> the pre-flight audience size (Meta rejects < 1,000)
--
-- Before this, POST /v1/ads/campaigns was called with a payload it does not
-- accept, so only a bare campaign ever existed and there was nothing to store
-- the ad set or ad in. Without these columns a launched ad cannot be paused,
-- synced or audited per level.

alter table ad_campaigns add column if not exists objective text;
alter table ad_campaigns add column if not exists optimization_goal text;
alter table ad_campaigns add column if not exists ad_set_id text;
alter table ad_campaigns add column if not exists ad_id text;
alter table ad_campaigns add column if not exists creative_id text;
alter table ad_campaigns add column if not exists ad_set_name text;
alter table ad_campaigns add column if not exists ad_name text;
alter table ad_campaigns add column if not exists image_url text;
alter table ad_campaigns add column if not exists targeting jsonb;
alter table ad_campaigns add column if not exists launch_payload jsonb;
alter table ad_campaigns add column if not exists reach_estimate jsonb;

-- Widen the status check to the values this app now writes. The v3 migration
-- allowed ('generating','launched','paused','approved','declined',
-- 'pending_human','error','approved_pending_manual_launch'); 'rejected' is what
-- decide_ad_finance returns when a prior ad underperformed, and 'live' is the
-- explicit "provider confirmed and delivering" state.
alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in (
    'draft', 'generating', 'pending_audit', 'audit_failed',
    'pending_finance', 'approved', 'declined', 'rejected', 'pending_human',
    'launched', 'live', 'paused',
    'error', 'approved_pending_manual_launch', 'duplicate'
  ));

create index if not exists ad_campaigns_ad_set_idx on ad_campaigns(ad_set_id);
create index if not exists ad_campaigns_ad_idx on ad_campaigns(ad_id);

-- 2/3 fix_decide_ad_finance_prior_ads.sql
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

-- 3/3 sync_ad_performance_rpc.sql
-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- The Meta/Google/TikTok ad audit workflows compute performance metrics but
-- never write them to ad_performance, so decide_ad_finance's "check the prior
-- ad's is_good" logic had nothing to read. This RPC lets an audit workflow
-- sync one ad's metrics per call using Zernio's own campaign id (which it
-- already has), without needing to look up our internal ad_campaigns.id first.

create or replace function sync_ad_performance(
  p_zernio_campaign_id text,
  p_impressions bigint default null,
  p_clicks bigint default null,
  p_spend numeric default null,
  p_conversions integer default null,
  p_ctr numeric default null,
  p_cpa numeric default null,
  p_is_good boolean default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ad_campaign_id uuid;
  v_performance_id uuid;
begin
  select id into v_ad_campaign_id
  from ad_campaigns
  where zernio_campaign_id = p_zernio_campaign_id
  limit 1;

  if v_ad_campaign_id is null then
    raise exception 'No ad_campaigns row found with zernio_campaign_id = %', p_zernio_campaign_id;
  end if;

  insert into ad_performance (ad_campaign_id, impressions, clicks, spend, leads, ctr, cpl, is_good)
  values (v_ad_campaign_id, p_impressions, p_clicks, p_spend, p_conversions, p_ctr, p_cpa, p_is_good)
  returning id into v_performance_id;

  return v_performance_id;
end;
$$;

notify pgrst, 'reload schema';
