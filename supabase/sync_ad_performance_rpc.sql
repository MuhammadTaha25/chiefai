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
