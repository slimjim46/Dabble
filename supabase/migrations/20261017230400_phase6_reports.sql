-- Phase 6.4: report_stroke — silent eligibility checks, deduplication, and
-- auto-hide once a stroke reaches reports_to_hide distinct reports.

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

  select user_id, hidden into stroke_owner, currently_hidden
  from public.strokes
  where id = p_stroke_id;

  if stroke_owner is null then
    return jsonb_build_object('hidden', false);
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
