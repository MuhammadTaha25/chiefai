-- Lets a client add a domain they already own (DNS hosted elsewhere, not
-- bought through us via Hostinger) and set up mailboxes on it themselves.
-- When true, provisioning skips writing DNS into our Hostinger account's
-- zone for this domain (it isn't there) and only verifies against whatever
-- records the client added at their own DNS provider.
alter table domains add column if not exists dns_managed_externally boolean not null default false;
