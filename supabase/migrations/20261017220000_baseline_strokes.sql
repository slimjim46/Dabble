-- Baseline: schema that already existed before Phases (from supabase/schema.sql).
-- Captured by hand because `supabase db pull` requires Docker, which is not
-- available in this environment. Idempotent; safe to re-run.

create table if not exists public.strokes (
  id          uuid primary key,
  user_id     uuid not null default auth.uid(),
  user_name   text not null check (char_length(user_name) between 1 and 24),
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  width       real not null check (width between 1 and 40),
  points      jsonb not null check (
                jsonb_typeof(points) = 'array'
                and jsonb_array_length(points) between 2 and 8000
                and jsonb_array_length(points) % 2 = 0),
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- history load (newest first) and reconnect catch-up both filter hidden + sort by created_at
create index if not exists strokes_visible_created_idx
  on public.strokes (created_at desc, id desc) where hidden = false;

alter table public.strokes enable row level security;

drop policy if exists strokes_select on public.strokes;
drop policy if exists strokes_insert on public.strokes;
drop policy if exists strokes_update_own on public.strokes;

-- Everyone can read visible strokes. You can also still see your OWN hidden ones:
-- without that, "undo" (UPDATE ... SET hidden = true) can fail with
-- "new row violates row-level security policy" because the updated row would no
-- longer pass the SELECT policy.
create policy strokes_select on public.strokes
  for select using (hidden = false or user_id = auth.uid());

-- Only signed-in (anonymous counts) users, and only as themselves, never pre-hidden.
create policy strokes_insert on public.strokes
  for insert to authenticated
  with check (user_id = auth.uid() and hidden = false);

-- Undo: you may only touch your own strokes.
create policy strokes_update_own on public.strokes
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- NOTE (Phase 6): these three policies are the hand-made loose ones the owner
-- wants replaced: the update policy allows editing any column of one's own
-- strokes, and although there is no delete policy here, production had one.
-- Phase 6 drops and recreates them with column-limited updates and no delete.
