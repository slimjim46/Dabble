-- Phase 3: reports — written only by the Phase 6 report RPC (security definer).
-- No client access.

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  stroke_id   uuid not null references public.strokes (id) on delete cascade,
  reporter_id uuid not null references public.players (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint reports_stroke_reporter_key unique (stroke_id, reporter_id)
);

alter table public.reports enable row level security;

revoke all on public.reports from anon, authenticated;
