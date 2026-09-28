-- Run in Supabase SQL editor. Expands client_social_profile with the business
-- knowledge fields DM/comment automation needs to answer real questions
-- without inventing information (pricing, FAQs, hours, must/must-not-say).
-- Non-destructive: only adds columns, existing rows/data untouched.

alter table client_social_profile add column if not exists business_description text;
alter table client_social_profile add column if not exists services text;
alter table client_social_profile add column if not exists faqs text;
alter table client_social_profile add column if not exists usps text;
alter table client_social_profile add column if not exists offers text;
alter table client_social_profile add column if not exists pricing_info text;
alter table client_social_profile add column if not exists must_say text;
alter table client_social_profile add column if not exists must_not_say text;
alter table client_social_profile add column if not exists contact_method text;
alter table client_social_profile add column if not exists booking_method text;
alter table client_social_profile add column if not exists business_hours text;
alter table client_social_profile add column if not exists website text;
