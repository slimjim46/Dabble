-- Phase 3: players — one row per auth user, created automatically.
-- Deliberately NO foreign key from strokes.user_id to players: an FK violation
-- would permanently drop a user's stroke (AGENTS.md invariant 1).

create table if not exists public.players (
  id           uuid primary key references auth.users (id) on delete cascade,
  name         text not null default 'Guest',
  created_at   timestamptz not null default now(),
  last_country char(2) null,
  banned       boolean not null default false,
  banned_at    timestamptz null,
  ban_reason   text null
);

alter table public.players enable row level security;

-- Create the players row automatically for every auth user, including
-- anonymous sign-ins. The client never creates it.
create or replace function public.handle_new_player()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.players (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_player() from public;
grant execute on function public.handle_new_player() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_player();

-- Backfill: one players row per distinct strokes.user_id that exists in auth.users.
insert into public.players (id)
select distinct s.user_id
from public.strokes s
join auth.users u on u.id = s.user_id
on conflict (id) do nothing;

-- Clients may read their own row and nothing else. No client insert/update/delete;
-- name changes go through an RPC (Phase 6).
drop policy if exists players_select_own on public.players;
create policy players_select_own on public.players
  for select to authenticated
  using (id = auth.uid());

revoke all on public.players from anon;
grant select on public.players to authenticated;
revoke insert, update, delete on public.players from authenticated;
