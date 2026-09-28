-- Applied to the live project. Optional posting-time preference for the settings-driven scheduler.
-- post_time is "HH:MM" local time (feed posts; stories follow ~2h later). NULL = default (17:00 / 19:00).
-- timezone is an IANA name; NULL = the server's CONTENT_TIMEZONE.
alter table social_automation_settings add column if not exists post_time text;
alter table social_automation_settings add column if not exists timezone text;
