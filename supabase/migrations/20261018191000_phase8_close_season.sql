-- Phase 8: close the current season. Admin-only, one transaction.
--
-- Non-destructive v1: stamps every unstamped stroke with the new season id and
-- retires the current live snapshot(s) so a new visitor cannot paint the old
-- board. Nothing is deleted.

create or replace function public.close_season(p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label    text := nullif(btrim(coalesce(p_label, '')), '');
  v_slug     text;
  v_started  timestamptz;
  v_ended    timestamptz := now();
  v_id       uuid;
  v_open     integer := 0;
  v_stamped  integer := 0;
  v_retired  integer := 0;
  n          integer := 1;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  if v_label is not null and char_length(v_label) > 80 then
    raise exception 'label too long' using errcode = '22023';
  end if;

  -- Serialise closes: a concurrent second call is rejected outright. An empty
  -- board is rejected below (decided: keep empty close rejected).
  if not pg_try_advisory_xact_lock(hashtext('dabble:close_season')) then
    raise exception 'a season close is already in progress' using errcode = '55006';
  end if;

  select count(*) into v_open
  from public.strokes
  where season_id is null;
  if v_open = 0 then
    raise exception 'no open season to close' using errcode = '22023';
  end if;

  -- Started when the previous season ended, or at the earliest live stroke.
  select max(ended_at) into v_started from public.seasons;
  if v_started is null then
    select min(created_at) into v_started
    from public.strokes
    where season_id is null;
  end if;
  v_started := coalesce(v_started, v_ended);

  loop
    v_slug := 'season-' || n;
    exit when not exists (select 1 from public.seasons where slug = v_slug);
    n := n + 1;
  end loop;

  insert into public.seasons (slug, label, started_at, ended_at)
  values (v_slug, coalesce(v_label, v_slug), v_started, v_ended)
  returning id into v_id;

  update public.strokes
     set season_id = v_id
   where season_id is null;
  get diagnostics v_stamped = row_count;

  -- Retire the live snapshot(s): with no kind='live' row left, a new visitor
  -- loads an empty board instead of the old season's baked PNG. The season's
  -- definitive final PNG is written later as kind='closed'.
  update public.snapshots
     set season_id = v_id, kind = 'retired'
   where kind = 'live' and season_id is null;
  get diagnostics v_retired = row_count;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'close_season', v_id::text,
          jsonb_build_object('slug', v_slug,
                             'label', coalesce(v_label, v_slug),
                             'strokes', v_stamped,
                             'retired_snapshots', v_retired));

  return jsonb_build_object(
    'id', v_id,
    'slug', v_slug,
    'label', coalesce(v_label, v_slug),
    'started_at', v_started,
    'ended_at', v_ended,
    'strokes', v_stamped,
    'retired_snapshots', v_retired
  );
end;
$$;

revoke execute on function public.close_season(text) from public, anon;
grant execute on function public.close_season(text) to authenticated;

-- Phase 8: report_stroke — reports on a closed season are rejected with a
-- permanent SQLSTATE (22023), so a client retry queue drops them instead of
-- retrying forever. Republished from 20261017230400_phase6_reports.sql with
-- ONLY the closed-season check added; every other branch is untouched so
-- report tests 13-15 keep their behaviour.

create or replace function public.report_stroke(p_stroke_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  lim record;
  stroke_owner uuid;
  stroke_season uuid;
  currently_hidden boolean;
  did_insert integer;
begin
  if uid is null then
    return jsonb_build_object('hidden', false);
  end if;

  select * into lim from public.dabble_limits();

  -- 1. Everything ineligible returns normally without doing anything, so the
  --    caller cannot learn why (throwaway accounts learn nothing).
  if exists (select 1 from public.players where id = uid and banned) then
    return jsonb_build_object('hidden', false);
  end if;

  select user_id, hidden, season_id
    into stroke_owner, currently_hidden, stroke_season
  from public.strokes
  where id = p_stroke_id;

  if stroke_owner is null then
    return jsonb_build_object('hidden', false);
  end if;

  -- A closed-season stroke is gone from the live board: a permanent error, not
  -- a silent no-op, so the caller never reports into an archive.
  if stroke_season is not null then
    raise exception 'season is closed' using errcode = '22023';
  end if;

  if stroke_owner = uid then
    return jsonb_build_object('hidden', currently_hidden);
  end if;

  if not exists (
    select 1 from public.players
    where id = uid
      and created_at <= now() - lim.min_reporter_age
  ) then
    return jsonb_build_object('hidden', currently_hidden);
  end if;

  if (
    select count(*) from public.reports
    where reporter_id = uid
      and created_at > now() - interval '1 minute'
  ) >= lim.max_reports_per_minute then
    return jsonb_build_object('hidden', currently_hidden);
  end if;

  -- 2. One report per reporter per stroke.
  insert into public.reports (stroke_id, reporter_id)
  values (p_stroke_id, uid)
  on conflict (stroke_id, reporter_id) do nothing;
  get diagnostics did_insert = row_count;
  if did_insert = 0 then
    return jsonb_build_object('hidden', currently_hidden);
  end if;

  update public.strokes
  set report_count = report_count + 1
  where id = p_stroke_id;

  -- 3. Auto-hide once enough distinct reports arrived (runs as the function
  --    owner, so the strokes update guard lets it through).
  update public.strokes
  set hidden = true, hidden_reason = 'reports'
  where id = p_stroke_id
    and report_count >= lim.reports_to_hide
    and reviewed = false
    and hidden = false;

  select hidden into currently_hidden
  from public.strokes
  where id = p_stroke_id;

  return jsonb_build_object('hidden', coalesce(currently_hidden, false));
end;
$$;
revoke execute on function public.report_stroke(uuid) from public, anon;
grant execute on function public.report_stroke(uuid) to authenticated;
