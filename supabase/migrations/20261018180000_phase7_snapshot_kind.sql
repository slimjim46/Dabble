-- Phase 7: tag snapshots by kind, so the Open Graph endpoint only ever
-- advertises the live board.
--
-- Seasons are not built yet, so every existing row becomes 'live' and nothing
-- else exists. When a season does close, its final snapshot is recorded as
-- 'closed' and /api/snapshot-latest skips it: a link preview shows the board
-- people can draw on right now, not a finished one. With no live snapshot
-- left the endpoint falls back to the static /og-default.png placeholder.
--
-- No new policy and no new grant: snapshots_select already reads every column
-- for every role, and anon/authenticated cannot insert, update or delete this
-- table, so nothing changes hands.
--
-- Open question for the seasons design (phase 8): scripts/render-snapshot.mjs
-- still picks its incremental base from the newest row of any kind, and prunes
-- by age across every kind. Both need revisiting when closed rows can exist.
--
-- Ordering: apply this before deploying the api/snapshot-latest.js change.
-- Filtering on a column this migration has not added makes that endpoint fall
-- back to the placeholder image rather than break.

alter table public.snapshots
  add column if not exists kind text not null default 'live';

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'snapshots_kind_check'
       and conrelid = 'public.snapshots'::regclass
  ) then
    alter table public.snapshots
      add constraint snapshots_kind_check check (kind in ('live', 'closed'));
  end if;
end $$;
