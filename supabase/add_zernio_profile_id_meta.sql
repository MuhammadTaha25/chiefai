-- Run in Supabase SQL editor. The free Zernio plan splits access across two
-- separate API keys (google+meta, tiktok+instagram) — each key is its own
-- Zernio account, so a profile created under one key doesn't exist under the
-- other. clients.zernio_profile_id now holds the tiktok/instagram-group
-- profile; this adds a second column for the google/meta-group profile.

alter table clients add column if not exists zernio_profile_id_meta text;
