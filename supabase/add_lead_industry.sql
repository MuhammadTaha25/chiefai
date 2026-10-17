-- Industry of each lead (from the prospect source's category), so emails and follow-ups stay on-topic.
alter table public.leads add column if not exists industry text;
