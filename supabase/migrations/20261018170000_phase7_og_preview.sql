-- Phase 7: Open Graph preview image for snapshots.
--
-- scripts/render-snapshot.mjs now writes a 1200x630 JPEG next to the full
-- 2000x2000 PNG, because every scraper wants a landscape image. Two additive
-- changes, both safe to re-run:
--
--   1. snapshots.preview_path records which object is the OG image. Rows that
--      predate this migration keep NULL and /api/snapshot-latest falls back to
--      the PNG, so the endpoint never has to guess or probe over the network.
--   2. the 'snapshots' bucket accepts JPEG alongside PNG (the bucket rejects
--      any MIME type outside allowed_mime_types).
--
-- No new policy and no new grant: snapshots_select already reads every column
-- for every role, and snapshots_objects_read already covers the whole bucket.
--
-- Ordering: apply this before the next render-snapshot run, or the INSERT of
-- preview_path fails against a database that does not have the column yet.

alter table public.snapshots
  add column if not exists preview_path text;

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg']
 where id = 'snapshots'
   and (allowed_mime_types is null
        or not (allowed_mime_types @> array['image/jpeg']));
