-- v2 Phase 5a: Daily Challenge — prompts, entries, votes, and their RPCs.
--
-- All writes go through security-definer RPCs; clients have no direct write
-- grants on any of these tables. Every tunable number lives in
-- public.dabble_limits() (plaza limits) or public.dabble_daily_limits()
-- (the daily window), so the submit path reuses the SAME limits as plaza
-- strokes instead of a second copy.
--
-- SQLSTATEs follow AGENTS.md: invalid data 22023 (permanent), banned 42501
-- (permanent). There is no retryable throttle here: a fixed batch of strokes
-- that exceeds a limit always will, so it is 22023, not PT429.

-- ---------------------------------------------------------------------------
-- Daily limits (kept OUT of dabble_limits() so the plaza trigger's return
-- type is untouched). Mirrors src/lib/constants.js in v2 Phase 5b.
-- ---------------------------------------------------------------------------
create or replace function public.dabble_daily_limits()
returns table (
  attempt_seconds integer,
  grace_seconds integer
)
language sql
immutable
set search_path = ''
as $$
  select 120, 10;
$$;
revoke execute on function public.dabble_daily_limits() from public, anon;
grant execute on function public.dabble_daily_limits() to authenticated;

-- ---------------------------------------------------------------------------
-- daily_prompts: one prompt per UTC date, owner-created (dashboard or dev
-- helper). No client write path. Clients read today's and past prompts only.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_prompts (
  id          uuid primary key default gen_random_uuid(),
  prompt_date date not null unique,
  prompt      text not null check (char_length(prompt) between 1 and 40),
  created_at  timestamptz not null default now()
);
alter table public.daily_prompts enable row level security;
revoke all on table public.daily_prompts from anon, authenticated;
drop policy if exists daily_prompts_select on public.daily_prompts;
create policy daily_prompts_select on public.daily_prompts
  for select to anon, authenticated
  using (prompt_date <= (now() at time zone 'utc')::date);
grant select on public.daily_prompts to anon, authenticated;

-- ---------------------------------------------------------------------------
-- daily_entries: one entry per player per day. strokes is a JSONB array of
-- {color, width, points} (flat points array), null until submitted. Hidden by
-- default (status pending) until an admin approves (v2 Phase 6 moderation
-- reuses this). The select policy is OWN ROWS ONLY: voters must never see
-- another player's id. The 5c voting grid reads entries via an RPC that
-- returns only (entry id, strokes), shuffled.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_entries (
  id           uuid primary key default gen_random_uuid(),
  prompt_id    uuid not null references public.daily_prompts (id),
  player_id    uuid not null references public.players (id) on delete cascade,
  strokes      jsonb,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  started_at   timestamptz not null default now(),
  submitted_at timestamptz null,
  created_at   timestamptz not null default now(),
  constraint daily_entries_prompt_player_key unique (prompt_id, player_id)
);
create index if not exists daily_entries_prompt_status_idx
  on public.daily_entries (prompt_id, status);
alter table public.daily_entries enable row level security;
revoke all on table public.daily_entries from anon, authenticated;
drop policy if exists daily_entries_select on public.daily_entries;
create policy daily_entries_select on public.daily_entries
  for select to authenticated
  using (player_id = auth.uid());
grant select on public.daily_entries to authenticated;

-- ---------------------------------------------------------------------------
-- daily_votes: written only by vote_daily_entry. No client grants.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_votes (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references public.daily_entries (id) on delete cascade,
  voter_id   uuid not null references public.players (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint daily_votes_entry_voter_key unique (entry_id, voter_id)
);
alter table public.daily_votes enable row level security;
revoke all on table public.daily_votes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- start_daily_attempt: record the server-side start time. Idempotent (a
-- reconnect mid-draw returns the same entry and never resets started_at).
-- A guest whose players row is missing (pre-Phase-4 gap) gets the row
-- recreated here, the same way the plaza does (handle_new_player / backfill /
-- set_my_name upsert), so a 23503 foreign-key violation can never escape.
-- ---------------------------------------------------------------------------
create or replace function public.start_daily_attempt(p_prompt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  entry_id uuid;
  started timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  -- Only today's prompt may be started.
  if not exists (
    select 1 from public.daily_prompts
    where id = p_prompt_id
      and prompt_date = (now() at time zone 'utc')::date
  ) then
    raise exception 'not today''s prompt' using errcode = '22023';
  end if;

  -- Recreate a missing players row (same shape as handle_new_player).
  insert into public.players (id) values (uid) on conflict (id) do nothing;

  select id, started_at into entry_id, started
  from public.daily_entries
  where prompt_id = p_prompt_id and player_id = uid;

  if entry_id is null then
    insert into public.daily_entries (prompt_id, player_id)
    values (p_prompt_id, uid)
    returning id, started_at into entry_id, started;
  end if;

  return jsonb_build_object('entry_id', entry_id, 'started_at', started);
end;
$$;
revoke execute on function public.start_daily_attempt(uuid) from public, anon;
grant execute on function public.start_daily_attempt(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_daily_entry: enforce the 2-minute window (plus grace) and validate
-- the strokes against the SAME dabble_limits() numbers the plaza trigger uses.
-- Mirrors strokes_before_insert's shape/ink checks, expressed over a JSONB
-- batch instead of a single row.
-- ---------------------------------------------------------------------------
create or replace function public.submit_daily_entry(p_prompt_id uuid, p_strokes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  lim record;
  dlim record;
  entry_rec record;
  cost double precision;
  total double precision := 0;
  s jsonb;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  select * into lim from public.dabble_limits();
  select * into dlim from public.dabble_daily_limits();

  select id, started_at, strokes, submitted_at into entry_rec
  from public.daily_entries
  where prompt_id = p_prompt_id and player_id = uid
  for update;

  if entry_rec.id is null then
    raise exception 'attempt not started' using errcode = '22023';
  end if;
  if entry_rec.submitted_at is not null or entry_rec.strokes is not null then
    raise exception 'already submitted' using errcode = '22023';
  end if;
  if now() > entry_rec.started_at + make_interval(secs => dlim.attempt_seconds + dlim.grace_seconds) then
    raise exception 'attempt timed out' using errcode = '22023';
  end if;

  if p_strokes is null or jsonb_typeof(p_strokes) <> 'array' then
    raise exception 'invalid strokes' using errcode = '22023';
  end if;
  if jsonb_array_length(p_strokes) > 2 * lim.max_strokes_per_minute then
    raise exception 'too many strokes' using errcode = '22023';
  end if;

  for s in select value from jsonb_array_elements(p_strokes) loop
    if jsonb_typeof(s) <> 'object' then
      raise exception 'invalid stroke' using errcode = '22023';
    end if;
    -- color: identical to strokes_before_insert ('^#[0-9a-fA-F]{6}$').
    if jsonb_typeof(s->'color') <> 'string' or s->>'color' !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'invalid color' using errcode = '22023';
    end if;
    -- width: identical range (lim.min_width..lim.max_width).
    if jsonb_typeof(s->'width') <> 'number'
       or (s->>'width')::real < lim.min_width
       or (s->>'width')::real > lim.max_width then
      raise exception 'invalid width' using errcode = '22023';
    end if;
    -- points: identical shape (flat array, 2..max numbers, even).
    if jsonb_typeof(s->'points') <> 'array'
       or jsonb_array_length(s->'points') < lim.min_point_numbers
       or jsonb_array_length(s->'points') > lim.max_point_numbers
       or jsonb_array_length(s->'points') % 2 <> 0 then
      raise exception 'invalid points' using errcode = '22023';
    end if;
    -- coordinates: identical range (0..lim.max_coord), number-typed only.
    if exists (
      select 1 from jsonb_array_elements(s->'points') as pt(value)
      where jsonb_typeof(pt.value) <> 'number'
         or (pt.value #>> '{}')::numeric not between 0 and lim.max_coord
    ) then
      raise exception 'points out of range' using errcode = '22023';
    end if;

    -- per-stroke ink: same formula and same capacity cap as the trigger.
    cost := public.stroke_path_length(s->'points') * (s->>'width')::real / 800.0;
    if cost > lim.ink_capacity then
      raise exception 'stroke costs more than the ink capacity' using errcode = '22023';
    end if;
    total := total + cost;
  end loop;

  -- The whole attempt's ink budget: capacity plus the refill over the window.
  if total > lim.ink_capacity + lim.ink_refill_per_sec * dlim.attempt_seconds then
    raise exception 'entry exceeds the ink budget' using errcode = '22023';
  end if;

  update public.daily_entries
  set strokes = p_strokes, submitted_at = now()
  where id = entry_rec.id;

  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.submit_daily_entry(uuid, jsonb) from public, anon;
grant execute on function public.submit_daily_entry(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vote_daily_entry: one vote per voter per entry, no self-votes, the voter
-- must have submitted that day's entry, and voting is only on the PREVIOUS
-- day's approved entries. A concurrent duplicate is caught as a unique
-- violation and re-raised as 22023.
-- ---------------------------------------------------------------------------
create or replace function public.vote_daily_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  entry_rec record;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  select de.id, de.player_id, de.status, de.submitted_at, dp.prompt_date
  into entry_rec
  from public.daily_entries de
  join public.daily_prompts dp on dp.id = de.prompt_id
  where de.id = p_entry_id;

  if entry_rec.id is null then
    raise exception 'entry not found' using errcode = '22023';
  end if;
  if entry_rec.player_id = uid then
    raise exception 'cannot vote on your own entry' using errcode = '22023';
  end if;
  if entry_rec.prompt_date <> ((now() at time zone 'utc')::date - 1) then
    raise exception 'voting is only for the previous day' using errcode = '22023';
  end if;
  if entry_rec.status <> 'approved' or entry_rec.submitted_at is null then
    raise exception 'entry is not votable' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.daily_entries de2
    join public.daily_prompts dp2 on dp2.id = de2.prompt_id
    where de2.player_id = uid
      and dp2.prompt_date = entry_rec.prompt_date
      and de2.submitted_at is not null
  ) then
    raise exception 'must have submitted that day''s entry' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.daily_votes where entry_id = p_entry_id and voter_id = uid
  ) then
    raise exception 'already voted' using errcode = '22023';
  end if;

  begin
    insert into public.daily_votes (entry_id, voter_id) values (p_entry_id, uid);
  exception
    when unique_violation then
      raise exception 'already voted' using errcode = '22023';
  end;

  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.vote_daily_entry(uuid) from public, anon;
grant execute on function public.vote_daily_entry(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_review_daily_entry: owner/admin approval, reusing is_admin() and
-- admin_audit_log (same columns the other admin_* RPCs write).
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_daily_entry(p_entry_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  update public.daily_entries
  set status = case when p_approve then 'approved' else 'rejected' end
  where id = p_entry_id;
  get diagnostics changed = row_count;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(),
          case when p_approve then 'approve_daily_entry' else 'reject_daily_entry' end,
          p_entry_id::text,
          jsonb_build_object('changed', changed));

  return jsonb_build_object('changed', changed);
end;
$$;
revoke execute on function public.admin_review_daily_entry(uuid, boolean) from public, anon;
grant execute on function public.admin_review_daily_entry(uuid, boolean) to authenticated;
