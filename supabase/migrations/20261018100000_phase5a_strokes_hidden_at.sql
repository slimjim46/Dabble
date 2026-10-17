-- Phase 5a: track when a stroke's visibility changed.
--
-- Snapshots bake in everything up to a cutoff. If a stroke that is already
-- baked in later gets hidden (admin hide, report auto-hide, ban-with-hide), the
-- baked PNG is stale and must be rebuilt from scratch instead of incrementally.
-- hidden_at is the marker the render script compares against the previous
-- snapshot's created_at.
--
-- Additive on the existing strokes table; does not touch any existing trigger.
alter table public.strokes add column if not exists hidden_at timestamptz null;

-- Detection query: strokes whose visibility changed on/after a moment in time.
create index if not exists strokes_hidden_at_idx
  on public.strokes (hidden_at) where hidden_at is not null;

-- A NEW trigger (name sorts after strokes_before_insert / strokes_guard_update
-- so it never interferes with them): stamp the moment visibility flips.
--
-- It stamps both directions. Hiding is the obvious case; un-hiding matters too,
-- because admin_restore_stroke can bring back a stroke that was hidden when the
-- previous snapshot was taken (it is absent from that PNG and, being older than
-- last_stroke_created_at, would never be drawn by an incremental run).
create or replace function public.strokes_set_hidden_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.hidden is distinct from old.hidden then
    new.hidden_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists strokes_set_hidden_at on public.strokes;
create trigger strokes_set_hidden_at
  before update on public.strokes
  for each row
  execute function public.strokes_set_hidden_at();

-- Filtered backfill in batches: strokes already hidden get their creation time
-- as a conservative marker (we do not know when they were actually hidden).
do $$
declare
  touched integer;
begin
  loop
    update public.strokes
    set hidden_at = created_at
    where id in (
      select id from public.strokes
      where hidden and hidden_at is null
      limit 1000
    );
    get diagnostics touched = row_count;
    exit when touched = 0;
  end loop;
end $$;
