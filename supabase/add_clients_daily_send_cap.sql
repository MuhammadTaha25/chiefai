-- Optional per-tenant daily cap for FIRST outreach emails. NULL (default) keeps the historical limit of 4/day,
-- so existing tenants are unaffected. When set, the effective cap is min(this value, sum of the tenant's mailbox
-- warmup-limited daily limits). Split across mailboxes by reserveMailboxSlot (fewest sends today first).
alter table clients add column if not exists daily_send_cap integer check (daily_send_cap is null or daily_send_cap >= 0);
