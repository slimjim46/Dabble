-- v2 Phase 5f: auto-approve daily entries on submit.
--
-- Entries no longer wait for admin review. When a player submits,
-- the entry goes straight to 'approved' and can be voted on and win.
-- Admin retains the ability to reject an entry afterwards (a rejected
-- entry disappears from the vote grid and cannot win).
--
-- Only intended changes from the latest function definitions:
--   submit_daily_entry: set status = 'approved' on submit
--   vote_daily_entry: accept 'approved' only (remove 'pending' logic)
--   get_daily_vote_grid: show 'approved' only (remove 'pending' logic)
--   admin_review_daily_entry: keep reject working; approve becomes no-op
-- All other validation, limits, row locks, and SQLSTATEs unchanged.

-- ---------------------------------------------------------------------------
-- submit_daily_entry: set status = 'approved' on submit.
-- Keeps: size cap, server-time checks, ban checks, row lock, all validations.
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
  if octet_length(p_strokes::text) > 262144 then
    raise exception 'entry too large' using errcode = '22023';
  end if;
  if jsonb_array_length(p_strokes) > 2 * lim.max_strokes_per_minute then
    raise exception 'too many strokes' using errcode = '22023';
  end if;

  for s in select value from jsonb_array_elements(p_strokes) loop
    if jsonb_typeof(s) <> 'object' then
      raise exception 'invalid stroke' using errcode = '22023';
    end if;
    if jsonb_typeof(s->'color') <> 'string' or s->>'color' !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'invalid color' using errcode = '22023';
    end if;
    if jsonb_typeof(s->'width') <> 'number'
       or (s->>'width')::real < lim.min_width
       or (s->>'width')::real > lim.max_width then
      raise exception 'invalid width' using errcode = '22023';
    end if;
    if jsonb_typeof(s->'points') <> 'array'
       or jsonb_array_length(s->'points') < lim.min_point_numbers
       or jsonb_array_length(s->'points') > lim.max_point_numbers
       or jsonb_array_length(s->'points') % 2 <> 0 then
      raise exception 'invalid points' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(s->'points') as pt(value)
      where jsonb_typeof(pt.value) <> 'number'
         or (pt.value #>> '{}')::numeric not between 0 and lim.max_coord
    ) then
      raise exception 'points out of range' using errcode = '22023';
    end if;

    cost := public.stroke_path_length(s->'points') * (s->>'width')::real / 800.0;
    if cost > lim.ink_capacity then
      raise exception 'stroke costs more than the ink capacity' using errcode = '22023';
    end if;
    total := total + cost;
  end loop;

  if total > lim.ink_capacity + lim.ink_refill_per_sec * dlim.attempt_seconds then
    raise exception 'entry exceeds the ink budget' using errcode = '22023';
  end if;

  update public.daily_entries
  set strokes = p_strokes, submitted_at = now(), status = 'approved'
  where id = entry_rec.id;

  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.submit_daily_entry(uuid, jsonb) from public, anon;
grant execute on function public.submit_daily_entry(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vote_daily_entry: accept 'approved' only (remove 'pending' logic).
-- Keeps: same-day + yesterday voting, 3-vote cap, row lock, ban checks.
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
  vote_count integer;
  today date := (now() at time zone 'utc')::date;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  -- Lock the voter's players row so concurrent calls serialize.
  perform 1 from public.players where id = uid for update;

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
  if entry_rec.prompt_date not in (today, today - 1) then
    raise exception 'voting is only for today or yesterday' using errcode = '22023';
  end if;
  if entry_rec.submitted_at is null then
    raise exception 'entry is not votable' using errcode = '22023';
  end if;
  -- Both today and yesterday require approved status (no pending)
  if entry_rec.status <> 'approved' then
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

  -- 3-vote daily cap (per prompt date, via entries join).
  select count(*) into vote_count
  from public.daily_votes dv
  join public.daily_entries de on de.id = dv.entry_id
  join public.daily_prompts dp on dp.id = de.prompt_id
  where dv.voter_id = uid
    and dp.prompt_date = entry_rec.prompt_date;
  if vote_count >= 3 then
    raise exception 'vote limit reached' using errcode = '22023';
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
-- get_daily_vote_grid: show 'approved' only (remove 'pending' logic).
-- Keeps: same-day preference, 12 per page, stable per-voter order.
-- ---------------------------------------------------------------------------
create or replace function public.get_daily_vote_grid(
  p_limit integer default 12,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  target_date date;
  voted_ids uuid[];
  grid jsonb;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  -- Prefer today's prompt when the caller submitted it; otherwise yesterday's.
  select dp.prompt_date into target_date
  from public.daily_entries de
  join public.daily_prompts dp on dp.id = de.prompt_id
  where de.player_id = uid
    and de.submitted_at is not null
    and dp.prompt_date in (today, today - 1)
  order by dp.prompt_date desc
  limit 1;

  if target_date is null then
    return jsonb_build_object('has_voted', false, 'voted_entry_ids', '[]'::jsonb, 'entries', '[]'::jsonb);
  end if;

  select coalesce(array_agg(dv.entry_id), array[]::uuid[]) into voted_ids
  from public.daily_votes dv
  join public.daily_entries de on de.id = dv.entry_id
  join public.daily_prompts dp on dp.id = de.prompt_id
  where dv.voter_id = uid
    and dp.prompt_date = target_date;

  -- Stable per-voter order, capped at 12 per page, excluding caller's own entry.
  select coalesce(jsonb_agg(jsonb_build_object('id', de.id, 'strokes', de.strokes)), '[]'::jsonb)
  into grid
  from (
    select de.id, de.strokes
    from public.daily_entries de
    join public.daily_prompts dp on dp.id = de.prompt_id
    where dp.prompt_date = target_date
      and de.submitted_at is not null
      and de.player_id <> uid
      and de.status = 'approved'  -- pending removed
    order by md5(uid::text || de.id::text)
    limit least(greatest(coalesce(p_limit, 12), 1), 12)
    offset greatest(coalesce(p_offset, 0), 0)
  ) de;

  return jsonb_build_object(
    'has_voted', coalesce(array_length(voted_ids, 1), 0) > 0,
    'voted_entry_ids', to_jsonb(voted_ids),
    'entries', grid
  );
end;
$$;
revoke execute on function public.get_daily_vote_grid(integer, integer) from public, anon;
grant execute on function public.get_daily_vote_grid(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_review_daily_entry: keep reject working; approve becomes no-op.
-- Keeps: admin check, null p_approve rejection, submitted_at check, audit log.
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_daily_entry(p_entry_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
  v_submitted timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  if p_approve is null then
    raise exception 'approve flag required' using errcode = '22023';
  end if;

  select submitted_at into v_submitted
  from public.daily_entries where id = p_entry_id;
  if v_submitted is null then
    raise exception 'entry not submitted' using errcode = '22023';
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