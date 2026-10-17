-- Phase 6.5 (follow-up): is_admin() must also reject anonymous sessions.
-- Anonymous tokens still have role = 'authenticated' (see AGENTS.md), but the
-- JWT carries is_anonymous = true, so checking it is explicit and cheap.

create or replace function public.is_admin()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
begin
  return coalesce(claims ->> 'role', '') = 'authenticated'
     and coalesce((claims ->> 'is_anonymous')::boolean, false) = false
     and coalesce(claims -> 'app_metadata' ->> 'role', '') = 'admin';
end;
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
