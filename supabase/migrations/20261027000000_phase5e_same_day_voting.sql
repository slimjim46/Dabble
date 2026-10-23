-- v2 Phase 5e: same-day daily voting.

-- 1. vote_daily_entry: allow the current UTC day and the previous UTC day.
--    Today's entries may still be pending; yesterday's must be approved.
--    Pending entries remain ineligible for finalize until approved.
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
  if entry_rec.prompt_date = today then
    if entry_rec.status not in ('approved', 'pending') then
      raise exception 'entry is not votable' using errcode = '22023';
    end if;
  elsif entry_rec.status <> 'approved' then
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

-- 2. get_daily_vote_grid: show today's entries to players who submitted
--    today, otherwise yesterday's entries. Today includes pending entries;
--    yesterday stays approved-only. No author fields.
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
      and (
        de.status = 'approved'
        or (dp.prompt_date = today and de.status = 'pending')
      )
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
