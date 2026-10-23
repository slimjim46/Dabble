-- DEV ONLY — never apply this file to a production project.
-- Lives outside supabase/migrations/ on purpose so `db push` never picks it up.
-- Apply manually to the dev database only, AFTER 20261028000000_phase5f_auto_approve.sql.
--
-- Backfill: promote existing 'pending' entries that have been submitted
-- (have submitted_at set) to 'approved'.
-- Run the count query first to see how many rows will be affected.

-- Count query (run first to verify):
-- select count(*) from public.daily_entries where status = 'pending' and submitted_at is not null;

-- Backfill update:
update public.daily_entries
set status = 'approved'
where status = 'pending'
  and submitted_at is not null;