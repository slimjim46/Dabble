-- DEV ONLY — never apply this file to a production project.
-- It lives outside supabase/migrations/ on purpose so `db push` never picks
-- it up. Apply manually to the dev database only.
--
-- Lets a test player flip their OWN players.banned flag so the rooms server's
-- ban-rejection path (403 before upgrade) is testable without an admin JWT.
-- Tests must unban at the end.

create or replace function public.dev_only_set_banned(p_banned boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'dev helper: sign in first' using errcode = '42501';
  end if;
  update public.players
  set banned = p_banned,
      banned_at = case when p_banned then now() else null end,
      ban_reason = case when p_banned then 'dev test' else null end
  where id = auth.uid();
end;
$$;
revoke execute on function public.dev_only_set_banned(boolean) from public, anon;
grant execute on function public.dev_only_set_banned(boolean) to authenticated;
