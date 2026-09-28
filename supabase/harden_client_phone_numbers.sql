-- Voice provisioning safety. Verified against the live table: nothing stops the
-- SAME phone number (or Twilio SID) from being stored for two tenants, and inbound
-- routing resolves the tenant from the CALLED number, so a duplicate active number
-- would send one tenant's call to another tenant. Only one ACTIVE row per number,
-- and one row per Twilio SID. (One active number per client is already enforced.)
-- The app also refuses to activate a number another tenant holds, and fails closed
-- on lookup when a number is ambiguous.
create unique index if not exists client_phone_numbers_active_number_uniq
  on public.client_phone_numbers (twilio_number)
  where status = 'active';

create unique index if not exists client_phone_numbers_sid_uniq
  on public.client_phone_numbers (twilio_sid);
