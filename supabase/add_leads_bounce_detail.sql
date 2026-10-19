-- Record-only: the receiving server's own failure message (Mailgun delivery-status / reason) for the latest failed delivery.
alter table leads add column if not exists bounce_detail jsonb;
