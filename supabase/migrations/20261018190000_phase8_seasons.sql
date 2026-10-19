-- Phase 8: seasons. A season is a named block of strokes; the "current"
-- season is simply every stroke with season_id is null. Closing is a manual,
-- admin-only, non-destructive stamp: nothing is deleted or moved.
--
-- Downstream (render script, RPCs, client, RLS) only ever treats season_id
-- is null as live.

create table if not exists public.seasons (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique,
  label                text,
  started_at           timestamptz,
  ended_at             timestamptz,
  final_snapshot_path  text,
  created_at           timestamptz not null default now()
);

-- Public read for the gallery and the client's "did the season change?" check.
-- No insert/update/delete policy and no such grants: only close_season (as its
-- owner) can write.
alter table public.seasons enable row level security;
drop policy if exists seasons_select on public.seasons;
create policy seasons_select on public.seasons
  for select to anon, authenticated
  using (true);
revoke all on table public.seasons from anon, authenticated;
grant select on table public.seasons to anon, authenticated;

-- Strokes and snapshots gain an optional season. Both null until a close.
alter table public.strokes
  add column if not exists season_id uuid references public.seasons(id);
alter table public.snapshots
  add column if not exists season_id uuid references public.seasons(id);

-- Live-path partial indexes: everything the drawing paths read is now
-- "season_id is null and visible".
create index if not exists strokes_live_created_idx
  on public.strokes (created_at desc, id desc)
  where season_id is null and hidden = false;
create index if not exists strokes_live_bbox_gist_idx
  on public.strokes using gist (bbox)
  where season_id is null and hidden = false;
-- Finalization reads a closed season by id.
create index if not exists strokes_season_idx
  on public.strokes (season_id)
  where season_id is not null;

-- Snapshot indexes: live lookup, and the prune candidate set (live+retired).
create index if not exists snapshots_live_created_idx
  on public.snapshots (created_at desc)
  where kind = 'live';
create index if not exists snapshots_prunable_created_idx
  on public.snapshots (created_at desc)
  where kind in ('live', 'retired');

-- Extend the kind check to live/retired/closed (idempotent drop+add).
alter table public.snapshots drop constraint if exists snapshots_kind_check;
alter table public.snapshots
  add constraint snapshots_kind_check check (kind in ('live', 'retired', 'closed'));

-- Live queries must never see a closed season, even via the anon REST
-- endpoint. Owners still read their own hidden live strokes. The admin branch
-- is inlined JWT claims (wrapped in a scalar subquery so the call is an
-- initplan evaluated once per statement), NOT public.is_admin(): that function
-- is revoked from anon and a policy is privilege-checked as the caller, so
-- calling it here would break anonymous SELECT outright. Admin reads go
-- through the SECURITY DEFINER RPCs and bypass RLS anyway.
drop policy if exists strokes_select on public.strokes;
create policy strokes_select on public.strokes
  for select to anon, authenticated
  using (
    (hidden = false or user_id = auth.uid())
    and (
      season_id is null
      or (
        coalesce((select auth.jwt()) ->> 'role', '') = 'authenticated'
        and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
        and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin'
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Republish strokes_before_insert so a client-supplied season_id is ignored.
-- The client has a table-level INSERT grant, so season_id must be overwritten
-- like every other untrusted field. The rest of the function is unchanged from
-- 20261017230700_phase6_insert_trigger_definer.sql.
-- ---------------------------------------------------------------------------
create or replace function public.strokes_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim record;
  uid uuid := auth.uid();
  bucket record;
  cost double precision;
  refill double precision;
  recent integer;
  stored_name text;
begin
  -- 0. A duplicate id never errors and never spends ink: the client upserts
  --    with ignore-duplicates, so the row is discarded anyway.
  if exists (select 1 from public.strokes where id = new.id) then
    return new;
  end if;

  select * into lim from public.dabble_limits();

  -- 1. Banned players cannot draw (permanent error: retrying never helps).
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  -- 2. Overwrite, never trust the client.
  if uid is not null then
    new.user_id := uid;
    select name into stored_name from public.players where id = uid;
    new.user_name := coalesce(stored_name, 'Guest');
  end if;
  new.hidden := false;
  new.hidden_reason := null;
  new.report_count := 0;
  new.reviewed := false;
  new.season_id := null;
  new.created_at := now();

  -- 3. Validate shape. Permanent errors (22023): a retry can never succeed.
  if new.color is null or new.color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'invalid color' using errcode = '22023';
  end if;
  if new.width is null or new.width < lim.min_width or new.width > lim.max_width then
    raise exception 'invalid width' using errcode = '22023';
  end if;
  if new.points is null or jsonb_typeof(new.points) <> 'array' then
    raise exception 'invalid points' using errcode = '22023';
  end if;
  if jsonb_array_length(new.points) < lim.min_point_numbers
     or jsonb_array_length(new.points) > lim.max_point_numbers
     or jsonb_array_length(new.points) % 2 <> 0 then
    raise exception 'invalid points' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.points) as e(value)
    where jsonb_typeof(e.value) <> 'number'
       or (e.value #>> '{}')::numeric not between 0 and lim.max_coord
  ) then
    raise exception 'points out of range' using errcode = '22023';
  end if;

  -- 4. Ink bucket (soft limit). Concurrent inserts from one user serialise on
  --    the row lock, so two strokes can never spend the same ink.
  insert into public.ink_buckets (user_id, ink, updated_at)
  values (new.user_id, lim.ink_capacity, now())
  on conflict (user_id) do nothing;

  select * into bucket from public.ink_buckets
  where user_id = new.user_id
  for update;

  refill := least(
    lim.ink_capacity,
    bucket.ink + lim.ink_refill_per_sec
      * extract(epoch from now() - bucket.updated_at)::double precision
  );
  cost := public.stroke_path_length(new.points) * new.width / 800.0;

  if cost > lim.ink_capacity then
    raise exception 'stroke costs more than the ink capacity' using errcode = '22023';
  end if;
  if cost > refill then
    raise exception 'out of ink' using errcode = 'PT429';
  end if;

  update public.ink_buckets
  set ink = refill - cost, updated_at = now()
  where user_id = new.user_id;

  -- 5. Strokes per minute (soft limit, retried by the client queue).
  select count(*) into recent
  from public.strokes
  where user_id = new.user_id
    and created_at > now() - interval '60 seconds';
  if recent >= lim.max_strokes_per_minute then
    raise exception 'too many strokes per minute' using errcode = 'PT429';
  end if;

  return new;
end;
$$;

drop trigger if exists strokes_before_insert on public.strokes;
create trigger strokes_before_insert
  before insert on public.strokes
  for each row
  execute function public.strokes_before_insert();

revoke execute on function public.strokes_before_insert() from public, anon;
grant execute on function public.strokes_before_insert() to authenticated;

-- ---------------------------------------------------------------------------
-- Republish strokes_near so hit-testing ignores closed seasons. The rest of
-- the function is unchanged from 20261018101000_phase5a_strokes_bbox_near.sql.
--
-- Up to 10 visible strokes whose bounding box overlaps the point +/- radius,
-- newest first. Radius is capped at 40 (the widest stroke). Aggregates only
-- what the caller needs to draw a hit: no user_id, no created_at.
-- ---------------------------------------------------------------------------
create or replace function public.strokes_near(
  p_x real,
  p_y real,
  p_radius real default 8
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select greatest(least(coalesce(p_radius, 8::real), 40::real), 0::real)::double precision as radius
  ),
  area as (
    select box(
      point(p_x::double precision - r.radius, p_y::double precision - r.radius),
      point(p_x::double precision + r.radius, p_y::double precision + r.radius)
    ) as b
    from r
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', hit.id,
        'user_name', hit.user_name,
        'color', hit.color,
        'width', hit.width,
        'points', hit.points
      )
      order by hit.created_at desc, hit.id desc
    ),
    '[]'::jsonb
  )
  from (
    select s.id, s.user_name, s.color, s.width, s.points, s.created_at
    from public.strokes s, area
    where s.hidden = false
      and s.season_id is null
      and s.bbox is not null
      and s.bbox && area.b
    order by s.created_at desc, s.id desc
    limit 10
  ) hit;
$$;
revoke execute on function public.strokes_near(real, real, real) from public, anon;
grant execute on function public.strokes_near(real, real, real) to authenticated;
