-- v2 Phase 5c-2: daily challenge voting.

-- 1. vote_daily_entry: up to 3 votes per voter per day, with a players-row
--    lock so concurrent calls cannot exceed 3.
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

-- 2. get_daily_vote_grid: no voter param, uses auth.uid(). Stable per-voter
--    order, 12 per page. Returns entry_id + strokes + voted_entry_ids.
--    No author fields. Banned / non-participant gets empty grid.
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
  voted_ids uuid[];
  grid jsonb;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  -- Voter must have submitted that day's entry (the previous day's prompt).
  if not exists (
    select 1
    from public.daily_entries de
    join public.daily_prompts dp on dp.id = de.prompt_id
    where de.player_id = uid
      and dp.prompt_date = ((now() at time zone 'utc')::date - 1)
      and de.submitted_at is not null
  ) then
    return jsonb_build_object('has_voted', false, 'voted_entry_ids', '[]'::jsonb, 'entries', '[]'::jsonb);
  end if;

  -- Collect the caller's voted entry ids for this day.
  select coalesce(array_agg(dv.entry_id), array[]::uuid[]) into voted_ids
  from public.daily_votes dv
  join public.daily_entries de on de.id = dv.entry_id
  join public.daily_prompts dp on dp.id = de.prompt_id
  where dv.voter_id = uid
    and dp.prompt_date = ((now() at time zone 'utc')::date - 1);

  -- Stable per-voter order, capped at 12 per page, excluding caller's own entry.
  select coalesce(jsonb_agg(jsonb_build_object('id', de.id, 'strokes', de.strokes)), '[]'::jsonb)
  into grid
  from (
    select de.id, de.strokes
    from public.daily_entries de
    join public.daily_prompts dp on dp.id = de.prompt_id
    where dp.prompt_date = ((now() at time zone 'utc')::date - 1)
      and de.status = 'approved'
      and de.submitted_at is not null
      and de.player_id <> uid
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

-- 3. daily_winners table + finalize_daily_winners + admin_hide_daily_winner

create table if not exists public.daily_winners (
  prompt_date date primary key,
  entry_id uuid references public.daily_entries (id) on delete set null,
  votes integer not null default 0,
  finalized_at timestamptz not null default now(),
  hidden boolean not null default false
);
alter table public.daily_winners enable row level security;
revoke all on table public.daily_winners from anon, authenticated;
create policy daily_winners_select on public.daily_winners
  for select to anon, authenticated
  using (hidden = false);
grant select on public.daily_winners to anon, authenticated;

create or replace function public.finalize_daily_winners(p_prompt_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  winner_id uuid;
  winner_votes integer;
begin
  -- Only service_role or postgres may call this.
  if session_user not in ('postgres', 'service_role') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Idempotent: if already finalized, return the existing result.
  if exists (select 1 from public.daily_winners where prompt_date = p_prompt_date) then
    return (select jsonb_build_object('prompt_date', prompt_date, 'entry_id', entry_id, 'votes', votes, 'already_finalized', true)
            from public.daily_winners where prompt_date = p_prompt_date);
  end if;

  -- Find the winner: highest vote count, at least 1 vote.
  -- Tie-break: earliest submitted_at, then smallest id.
  select de.id, count(dv.id)::integer into winner_id, winner_votes
  from public.daily_entries de
  join public.daily_prompts dp on dp.id = de.prompt_id
  left join public.daily_votes dv on dv.entry_id = de.id
  where dp.prompt_date = p_prompt_date
    and de.status = 'approved'
    and de.submitted_at is not null
  group by de.id, de.submitted_at
  having count(dv.id) > 0
  order by count(dv.id) desc, de.submitted_at asc, de.id asc
  limit 1;

  if winner_id is null then
    -- No winner (no approved entries with votes). Still record finalization.
    insert into public.daily_winners (prompt_date, entry_id, votes)
    values (p_prompt_date, null, 0)
    on conflict (prompt_date) do nothing;
    return jsonb_build_object('prompt_date', p_prompt_date, 'entry_id', null, 'votes', 0, 'finalized', true);
  end if;

  insert into public.daily_winners (prompt_date, entry_id, votes)
  values (p_prompt_date, winner_id, winner_votes)
  on conflict (prompt_date) do nothing;

  return jsonb_build_object('prompt_date', p_prompt_date, 'entry_id', winner_id, 'votes', winner_votes, 'finalized', true);
end;
$$;
revoke execute on function public.finalize_daily_winners(date) from public, anon, authenticated;
grant execute on function public.finalize_daily_winners(date) to service_role;

create or replace function public.admin_hide_daily_winner(p_prompt_date date)
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

  update public.daily_winners
  set hidden = true
  where prompt_date = p_prompt_date and hidden = false;
  get diagnostics changed = row_count;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'hide_daily_winner', p_prompt_date::text,
          jsonb_build_object('changed', changed));

  return jsonb_build_object('changed', changed);
end;
$$;
revoke execute on function public.admin_hide_daily_winner(date) from public, anon;
grant execute on function public.admin_hide_daily_winner(date) to authenticated;
