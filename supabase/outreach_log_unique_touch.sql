-- One real email per lead per touch number (touch 0 = auto-replies, which may repeat). Only rows from 2026-10-17 on,
-- so older duplicate history does not block the index.
create unique index if not exists outreach_log_lead_touch_unique
  on public.outreach_log (lead_id, touch_number)
  where touch_number >= 1 and lead_id is not null and sent_at >= '2026-10-17T00:00:00Z';
