-- Recommended plan and the owner's per-day plan for the social scheduler.
-- NOT YET APPLIED. Run once in the Supabase SQL editor, then deploy.
-- weekly_plan: 7 entries, Mon..Sun, e.g.
--   [{"post":"none","story":false}, {"post":"image","story":true}, ...]
--   post is none | image | carousel | video. NULL = use the count columns (older settings).
-- story_time: "HH:MM" local time for stories. NULL = two hours after post_time.
alter table social_automation_settings add column if not exists weekly_plan jsonb;
alter table social_automation_settings add column if not exists story_time text;
