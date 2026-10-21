-- DEV ONLY — never apply to production.
-- Lives outside supabase/migrations/ so `db push` never picks it up.
--
-- Promotes the CURRENT (non-anonymous) caller to admin by writing
-- auth.users.raw_app_meta_data. is_admin() rejects anonymous users, so this
-- helper also refuses anonymous callers up front. The restriction on
-- app_metadata is enforced at the Auth API level, not the DB level, so a
-- security-definer function running as the postgres owner can write it.
--
-- Production guard: refuses to run unless a dev-only marker table exists.

-- Dev-only marker table (not a migration, lives in dev/ only).
create table if not exists public.dev_marker (k text primary key);
insert into public.dev_marker (k) values ('dev') on conflict (k) do nothing;

create or replace function public.dev_only_set_admin(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
begin
  if not exists (select 1 from public.dev_marker where k = 'dev') then
    raise exception 'dev helper: not in dev' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'dev helper: sign in first' using errcode = '42501';
  end if;
  if coalesce((claims ->> 'is_anonymous')::boolean, false) then
    raise exception 'dev helper: anonymous users cannot be admins' using errcode = '42501';
  end if;
  update auth.users
  set raw_app_meta_data = case when p_enabled
    then coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
    else raw_app_meta_data - 'role' end
  where id = auth.uid();
end;
$$;
revoke execute on function public.dev_only_set_admin(boolean) from public, anon;
grant execute on function public.dev_only_set_admin(boolean) to authenticated;
