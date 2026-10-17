-- DEV ONLY — never apply this file to a production project.
-- It lives outside supabase/migrations/ on purpose so `db push` never picks
-- it up. Apply manually to the dev database only.
--
-- Provides the two things tests/rls.test.mjs needs and the production schema
-- must not have:
--   1. a way for a test player to back-date their own players.created_at so
--      the MIN_REPORTER_AGE check can be exercised,
--   2. a single test term so set_my_name's blocked-term path is testable
--      (real word lists are supplied by the owner via
--      scripts/load-blocked-terms.mjs, never from the repo).

create or replace function public.dev_only_backdate_player(
  p_player_id uuid,
  p_created_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() <> p_player_id then
    raise exception 'dev helper: only for back-dating your own test player'
      using errcode = '42501';
  end if;
  update public.players
  set created_at = p_created_at
  where id = p_player_id;
end;
$$;
revoke execute on function public.dev_only_backdate_player(uuid, timestamptz)
  from public, anon;
grant execute on function public.dev_only_backdate_player(uuid, timestamptz)
  to authenticated;

insert into public.blocked_terms (term, severity)
values ('badword', 'substring')
on conflict (term) do nothing;
