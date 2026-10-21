-- Phase 8: private bucket for season JSONL.gz archive parts. The public
-- snapshots bucket only allows png/jpeg, and these archives are bulk user data
-- (including hidden rows and hidden_reason), so they live here. Service-role
-- only: deliberately no storage.objects policy for anon or authenticated, so
-- the storage API denies every client.
--
-- Parts are ~20k strokes each, kept well under the free plan's 50 MB object
-- limit; the endpoint accepts application/gzip (the uploader's content type).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('season-archives', 'season-archives', false, 47185920, array['application/gzip'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
