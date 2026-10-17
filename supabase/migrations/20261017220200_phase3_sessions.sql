-- Phase 3: sessions — written only by the Phase 4 server function using the
-- service role. No client access at all: clients can never fake last_seen
-- or playtime. Playtime is last_seen - login_time (no duration column).

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.players (id) on delete cascade,
  country_code char(2) null,
  login_time   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

alter table public.sessions enable row level security;

create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists sessions_country_code_idx on public.sessions (country_code);
create index if not exists sessions_last_seen_idx on public.sessions (last_seen);

revoke all on public.sessions from anon, authenticated;

-- Internal aggregation only. security_invoker so the view can never leak rows
-- through its owner's rights, and privileges are revoked from the API roles.
create or replace view public.session_durations
with (security_invoker = on) as
select
  id                    as session_id,
  user_id,
  country_code,
  login_time,
  last_seen,
  last_seen - login_time as playtime
from public.sessions;

revoke all on public.session_durations from anon, authenticated;
grant select on public.session_durations to service_role;
