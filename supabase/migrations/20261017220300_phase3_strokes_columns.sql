-- Phase 3: moderation columns on the existing strokes table.
-- Additive and idempotent; strokes already holds real user data.

alter table public.strokes add column if not exists hidden_reason text null;
alter table public.strokes add column if not exists report_count integer not null default 0;
alter table public.strokes add column if not exists reviewed boolean not null default false;

do $$
begin
  alter table public.strokes
    add constraint strokes_hidden_reason_check
    check (hidden_reason in ('undo', 'reports', 'admin'));
exception
  when duplicate_object then null;
end $$;

-- keep or create: history load and reconnect catch-up depend on it
create index if not exists strokes_visible_created_idx
  on public.strokes (created_at desc, id desc) where hidden = false;

-- per-user rate limits (Phase 6 strokes-per-minute check)
create index if not exists strokes_user_created_idx
  on public.strokes (user_id, created_at desc);
