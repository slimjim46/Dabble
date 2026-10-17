-- Phase 4 step 0a (part 2): set_my_name upserts the players row.
--
-- If the row is missing (user created before the players trigger existed, or
-- deleted by hand), the old UPDATE affected 0 rows and the chosen name was
-- silently lost. Now the row is recreated with the chosen name; validation
-- and the 5/hour rate limit are unchanged.

create or replace function public.set_my_name(new_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  trimmed text := coalesce(new_name, '');
  recent integer;
  per_hour integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if not public.is_name_allowed(trimmed) then
    raise exception 'name_not_allowed' using errcode = '22023';
  end if;

  select renames_per_hour into per_hour from public.dabble_limits();
  select count(*) into recent
  from public.name_changes
  where player_id = uid
    and created_at > now() - interval '1 hour';
  if recent >= per_hour then
    raise exception 'too many name changes' using errcode = 'PT429';
  end if;

  insert into public.players (id, name)
  values (uid, trimmed)
  on conflict (id) do update set name = excluded.name;

  insert into public.name_changes (player_id) values (uid);
  delete from public.name_changes where created_at < now() - interval '1 day';
end;
$$;
revoke execute on function public.set_my_name(text) from public, anon;
grant execute on function public.set_my_name(text) to authenticated;
