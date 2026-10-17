-- Phase 3: snapshots — used in Phase 5. last_stroke_created_at is a timestamp,
-- not a stroke id: stroke ids are random UUIDs and cannot mark "everything
-- after this point". Public read; no client writes.

create table if not exists public.snapshots (
  id                     uuid primary key default gen_random_uuid(),
  image_path             text not null,
  created_at             timestamptz not null default now(),
  last_stroke_created_at timestamptz not null
);

alter table public.snapshots enable row level security;

drop policy if exists snapshots_select on public.snapshots;
create policy snapshots_select on public.snapshots
  for select using (true);

revoke insert, update, delete on public.snapshots from anon, authenticated;
