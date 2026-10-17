-- Phase 5a: storage for canvas snapshots.
--
-- The 'snapshots' bucket is public-read (every client downloads the PNG) but
-- clients can never write it: the render script uploads with the service role,
-- which bypasses RLS. There is deliberately no INSERT/UPDATE/DELETE policy for
-- anon or authenticated on this bucket, so the storage API denies them.
--
-- Objects live at snapshots/<iso-timestamp>.png (the bucket is the "snapshots"
-- part); snapshots.image_path stores the object key (<iso-timestamp>.png).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snapshots', 'snapshots', true, 10485760, array['image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read of snapshot objects only (never any other bucket).
drop policy if exists snapshots_objects_read on storage.objects;
create policy snapshots_objects_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'snapshots');
