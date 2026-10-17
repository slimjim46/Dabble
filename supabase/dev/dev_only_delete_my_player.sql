-- DEV ONLY. Never apply to production. Never part of `supabase db push`
-- (this file lives outside supabase/migrations/ on purpose).
--
-- Deletes ONLY the caller's own players row, so tests can reproduce a user
-- whose players row is missing (the pre-Phase-4 bug) without needing the
-- service-role key.

create or replace function public.dev_only_delete_my_player()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from public.players where id = uid;
end;
$$;
revoke execute on function public.dev_only_delete_my_player() from public, anon;
grant execute on function public.dev_only_delete_my_player() to authenticated;
