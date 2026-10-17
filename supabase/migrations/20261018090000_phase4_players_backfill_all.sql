-- Phase 4 step 0a (part 1): backfill players for EVERY auth user.
--
-- The Phase 3 backfill only covered users who already had strokes, so older
-- anonymous users have no players row. Sessions reference players(id), so
-- /api/session must never hit a missing FK (a permanent 23503 that would
-- silently drop data). Idempotent.

insert into public.players (id)
select u.id
from auth.users u
on conflict (id) do nothing;
