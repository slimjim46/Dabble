-- v2 Phase 5b: start_daily_attempt returns the server clock so the client can
-- anchor its countdown without trusting the client clock. Same uuid -> jsonb
-- signature, same security definer / search_path / revoke-grant as 5a; only
-- the return gains a `server_now` field.

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
  server_now timestamptz := now();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from public.players where id = uid and banned) then
    raise exception 'player is banned' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.daily_prompts
    where id = p_prompt_id
      and prompt_date = (now() at time zone 'utc')::date
  ) then
    raise exception 'not today''s prompt' using errcode = '22023';
  end if;

  insert into public.players (id) values (uid) on conflict (id) do nothing;

  select id, started_at into entry_id, started
  from public.daily_entries
  where prompt_id = p_prompt_id and player_id = uid;

  if entry_id is null then
    insert into public.daily_entries (prompt_id, player_id)
    values (p_prompt_id, uid)
    returning id, started_at into entry_id, started;
  end if;

  return jsonb_build_object('entry_id', entry_id, 'started_at', started, 'server_now', server_now);
end;
$$;
revoke execute on function public.start_daily_attempt(uuid) from public, anon;
grant execute on function public.start_daily_attempt(uuid) to authenticated;
