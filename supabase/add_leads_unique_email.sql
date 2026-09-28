-- Phase 3. Duplicates were reconciled first (history moved to the canonical
-- lead), so this index can be created. It makes duplicate (client, email)
-- leads impossible — the cause of prospects being emailed twice when lead
-- generation ran twice. App code dedupes first and treats 23505 as "already exists".
create unique index if not exists leads_client_email_uniq
  on public.leads (client_id, lower(email))
  where email is not null;
