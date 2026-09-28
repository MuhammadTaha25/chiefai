-- Run in Supabase SQL editor. ad_campaigns_goal_check only allows an old/guessed
-- set of goal values. The ads-creative-brief n8n workflow writes goal straight
-- from the ad brief form's "desired_result" answer (src/lib/form-schema/ads-schema.ts
-- campaign_goal.desired_result options), which are these exact title-case
-- strings — so every ad submission was failing at "Create ad_campaigns Row
-- (draft)" with:
--   new row for relation "ad_campaigns" violates check constraint
--   "ad_campaigns_goal_check"
-- This widens the constraint to match what the form actually sends.

alter table ad_campaigns drop constraint if exists ad_campaigns_goal_check;
alter table ad_campaigns add constraint ad_campaigns_goal_check
  check (goal in (
    'Leads', 'Sales', 'Website visits', 'WhatsApp messages',
    'Phone calls', 'Bookings', 'App downloads', 'Brand awareness'
  ));
