-- v2 Phase 5c-3: fix finalize_daily_winners role check and zero-vote handling.

-- Remove the in-function role check (session_user is 'authenticator' via
-- PostgREST, current_user is the function owner — neither is a reliable
-- caller check). Rely on revoke/grant only: execute revoked from
-- public/anon/authenticated, granted to service_role.
-- Also: if no entry has at least 1 vote, write NO row and return
-- {finalized:false, reason:'no_votes'}.
-- Guard: if p_prompt_date > today-2, raise 22023 'voting not closed'.

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
  -- Guard: voting must be closed (UTC midnight starting D+2).
  if p_prompt_date > ((now() at time zone 'utc')::date - 2) then
    raise exception 'voting not closed' using errcode = '22023';
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
    -- No winner (no approved entries with votes). Write NO row.
    return jsonb_build_object('prompt_date', p_prompt_date, 'entry_id', null, 'votes', 0, 'finalized', false, 'reason', 'no_votes');
  end if;

  insert into public.daily_winners (prompt_date, entry_id, votes)
  values (p_prompt_date, winner_id, winner_votes)
  on conflict (prompt_date) do nothing;

  return jsonb_build_object('prompt_date', p_prompt_date, 'entry_id', winner_id, 'votes', winner_votes, 'finalized', true);
end;
$$;
revoke execute on function public.finalize_daily_winners(date) from public, anon, authenticated;
grant execute on function public.finalize_daily_winners(date) to service_role;
