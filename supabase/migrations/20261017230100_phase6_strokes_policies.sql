-- Phase 6.1: replace the loose strokes policies with column-limited ones.
--
--  - select: everyone reads visible strokes; owners also read their own hidden
--    ones (otherwise undo fails with "new row violates row-level security").
--  - insert: authenticated only, own user_id, never hidden.
--  - update: owner only, and only the `hidden` column (column-level grant).
--  - delete: no policy at all, and no delete grant. The app never deletes.

drop policy if exists strokes_select on public.strokes;
drop policy if exists strokes_insert on public.strokes;
drop policy if exists strokes_update_own on public.strokes;
drop policy if exists strokes_update on public.strokes;
drop policy if exists strokes_delete on public.strokes;
drop policy if exists strokes_delete_own on public.strokes;

create policy strokes_select on public.strokes
  for select to anon, authenticated
  using (hidden = false or user_id = auth.uid());

create policy strokes_insert_own on public.strokes
  for insert to authenticated
  with check (user_id = auth.uid() and hidden = false);

create policy strokes_update_hide_own on public.strokes
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on table public.strokes from anon, authenticated;
grant select on public.strokes to anon, authenticated;
grant insert on public.strokes to authenticated;
grant update (hidden) on public.strokes to authenticated;

-- Non-service roles may only take hidden from false to true (their own undo,
-- forced to hidden_reason = 'undo'). The service role and security definer
-- functions (owned by postgres, so current_user is postgres while they run)
-- bypass this: admin hides, report auto-hide, and restores need it.
create or replace function public.strokes_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.user_name is distinct from old.user_name
     or new.color is distinct from old.color
     or new.width is distinct from old.width
     or new.points is distinct from old.points
     or new.created_at is distinct from old.created_at
     or new.report_count is distinct from old.report_count
     or new.reviewed is distinct from old.reviewed then
    raise exception 'strokes may only be hidden' using errcode = '42501';
  end if;

  if new.hidden and not old.hidden then
    new.hidden_reason := 'undo';
    return new;
  end if;

  -- Un-hiding is never allowed for clients: keep the row as it was, silently,
  -- so the owner cannot erase a hide applied by reports or an admin.
  new.hidden := old.hidden;
  new.hidden_reason := old.hidden_reason;
  return new;
end;
$$;

drop trigger if exists strokes_guard_update on public.strokes;
create trigger strokes_guard_update
  before update on public.strokes
  for each row
  execute function public.strokes_guard_update();
