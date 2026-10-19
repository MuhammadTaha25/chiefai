-- Per-record DNS health (SPF/DKIM/MX/CNAME/DMARC) written by /api/cron/dns-health. Additive and nullable: existing rows untouched.
alter table domains add column if not exists dns_health jsonb;
alter table domains add column if not exists dns_checked_at timestamptz;
