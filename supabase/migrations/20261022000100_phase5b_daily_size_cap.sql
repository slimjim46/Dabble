-- v2 Phase 5b: bound the size of a submitted daily entry.
--
-- A hostile client can submit a zero-ink batch of 120 x 8000 identical points
-- (path length 0, so ink cost 0) that is ~7.7 MB of JSON; PostgREST would
-- accept it and it would be stored forever. This caps the JSONB text size at
-- 256 KiB (octet_length on p_strokes::text, which is the larger ", "/": "
-- separated form). A legitimate drawing is a few KiB to a few tens of KiB, so
-- the cap only ever rejects hostile or accidental oversized batches. Mirrored
-- client-side as DAILY_MAX_ENTRY_BYTES in src/daily/constants.js.

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
  set strokes = p_strokes, submitted_at = now()
  where id = entry_rec.id;

  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.submit_daily_entry(uuid, jsonb) from public, anon;
grant execute on function public.submit_daily_entry(uuid, jsonb) to authenticated;
