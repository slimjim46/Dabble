-- DEV ONLY — never apply this file to a production project.
-- Lives outside supabase/migrations/ on purpose so `db push` never picks it
-- up. Apply manually to the dev database only.
--
-- Helpers for tests/daily.test.mjs (v2 Phase 5a). They seed prompts and
-- entries, back-date started_at for the window tests, and simulate admin
-- approval (no admin JWT exists in the test harness).

-- Upsert a prompt for any date (today / yesterday / tomorrow), so the tests
-- can exercise "future prompts are unreadable" and "vote only on yesterday".
create or replace function public.dev_only_set_daily_prompt(
  p_prompt_date date,
  p_prompt text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pid uuid;
begin
  if auth.uid() is null then
    raise exception 'dev helper: sign in first' using errcode = '42501';
  end if;
  insert into public.daily_prompts (prompt_date, prompt)
  values (p_prompt_date, p_prompt)
  on conflict (prompt_date) do update set prompt = excluded.prompt
  returning id into pid;
  return pid;
end;
$$;
revoke execute on function public.dev_only_set_daily_prompt(date, text) from public, anon;
grant execute on function public.dev_only_set_daily_prompt(date, text) to authenticated;

-- Seed the CALLER's own entry with an arbitrary started_at / status / strokes,
-- bypassing the 2-minute window. Used to back-date attempts (too-late test)
-- and to create yesterday's entries for the vote tests.
create or replace function public.dev_only_seed_daily_entry(
  p_prompt_id uuid,
  p_strokes jsonb default null,
  p_started_at timestamptz default now(),
  p_status text default 'pending'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  eid uuid;
begin
  if uid is null then
    raise exception 'dev helper: sign in first' using errcode = '42501';
  end if;
  insert into public.daily_entries (prompt_id, player_id, strokes, status, started_at, submitted_at)
  values (p_prompt_id, uid, p_strokes, p_status, p_started_at,
          case when p_strokes is null then null else now() end)
  on conflict (prompt_id, player_id) do update
    set strokes = excluded.strokes,
        status = excluded.status,
        started_at = excluded.started_at,
        submitted_at = excluded.submitted_at
  returning id into eid;
  return eid;
end;
$$;
revoke execute on function public.dev_only_seed_daily_entry(uuid, jsonb, timestamptz, text) from public, anon;
grant execute on function public.dev_only_seed_daily_entry(uuid, jsonb, timestamptz, text) to authenticated;

-- Approve an entry (stand-in for the real admin_review_daily_entry RPC, which
-- the anonymous test harness cannot call as an admin).
create or replace function public.dev_only_approve_daily_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'dev helper: sign in first' using errcode = '42501';
  end if;
  update public.daily_entries
  set status = 'approved'
  where id = p_entry_id;
end;
$$;
revoke execute on function public.dev_only_approve_daily_entry(uuid) from public, anon;
grant execute on function public.dev_only_approve_daily_entry(uuid) to authenticated;
