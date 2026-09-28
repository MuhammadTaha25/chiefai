-- Applied to the live project. social_posts_status_check only allowed draft/published/failed, but the
-- app writes 'creating' (reserve-then-publish, manual composer) and 'scheduled' (scheduled posts), so
-- those inserts/updates were rejected. Superset of the old list: existing rows stay valid.
alter table social_posts drop constraint if exists social_posts_status_check;
alter table social_posts add constraint social_posts_status_check
  check (status = any (array['creating', 'draft', 'scheduled', 'published', 'failed']));
