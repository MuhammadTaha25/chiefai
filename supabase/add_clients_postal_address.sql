-- Optional sender postal address, appended to the footer of cold-outreach emails (anti-spam / CAN-SPAM style requirement).
-- The app reads it if present and omits the address line if the column is missing or empty, so this is safe to apply any time.
alter table clients add column if not exists postal_address text;
-- Then set it per client, e.g.:
-- update clients set postal_address = '123 Example St, City, ST 00000, Country' where id = '<client id>';
