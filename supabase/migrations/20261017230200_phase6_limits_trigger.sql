-- Phase 6.2: server-side validation and limits for stroke inserts.
--
-- All tunable numbers live in public.dabble_limits() (immutable, returns one
-- row) so retuning is a one-line migration. They must stay in sync with
-- src/lib/constants.js.

create or replace function public.dabble_limits()
returns table (
  ink_capacity real,
  ink_refill_per_sec real,
  max_strokes_per_minute integer,
  min_point_numbers integer,
  max_point_numbers integer,
  max_coord real,
  min_width real,
  max_width real,
  max_reports_per_minute integer,
  reports_to_hide integer,
  min_reporter_age interval,
  renames_per_hour integer
)
language sql
immutable
set search_path = ''
as $$
  select
    150::real,          -- ink_capacity: 1.5 x client INK_MAX (100)
    12::real,           -- ink_refill_per_sec
    60,                 -- max_strokes_per_minute
    2,                  -- min_point_numbers
    8000,               -- max_point_numbers
    2000::real,         -- max_coord (paper is 2000 x 2000)
    1::real,            -- min_width
    40::real,           -- max_width
    10,                 -- max_reports_per_minute
    3,                  -- reports_to_hide
    interval '10 minutes', -- min_reporter_age
    5;                  -- renames_per_hour
$$;
-- The insert trigger runs as the invoking user, so authenticated needs these.
revoke execute on function public.dabble_limits() from public, anon;
grant execute on function public.dabble_limits() to authenticated;

-- Per-user ink bucket. No client access: written only by the insert trigger.
create table if not exists public.ink_buckets (
  user_id uuid primary key,
  ink real not null,
  updated_at timestamptz not null default now(),
  constraint ink_buckets_ink_check check (ink >= 0)
);
alter table public.ink_buckets enable row level security;
revoke all on table public.ink_buckets from anon, authenticated;

-- Polyline length of a flat [x, y, ...] jsonb array, same units as the
-- client's pathLength() in src/lib/stroke.js.
create or replace function public.stroke_path_length(points jsonb)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  n integer := jsonb_array_length(points);
  px double precision;
  py double precision;
  total double precision := 0;
begin
  if n is null or n < 2 then
    return 0;
  end if;
  px := (points ->> 0)::double precision;
  py := (points ->> 1)::double precision;
  for i in 1..(n / 2 - 1) loop
    declare
      cx double precision := (points ->> i * 2)::double precision;
      cy double precision := (points ->> i * 2 + 1)::double precision;
    begin
      total := total + sqrt((cx - px) * (cx - px) + (cy - py) * (cy - py));
      px := cx;
      py := cy;
    end;
  end loop;
  return total;
end;
$$;
revoke execute on function public.stroke_path_length(jsonb) from public, anon;
grant execute on function public.stroke_path_length(jsonb) to authenticated;

create or replace function public.strokes_before_insert()
returns trigger
language plpgsql
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
