-- v2 Phase 5c-1: admin list of pending daily entries.

-- 1. admin_list_daily_entries: returns only what moderation needs.
--    player_id, name and country are deliberately omitted — the admin
--    moderates the DRAWING, not the person. If identity is ever needed
--    for a moderation decision, a separate audited
--    admin_get_daily_entry_author RPC can be added later.
--
--    Keyset paging on (submitted_at, id) instead of offset: stable under
--    inserts/deletes, and avoids scanning the whole table on every page.
create or replace function public.admin_list_daily_entries(
  p_prompt_date date default null,
  p_status text default 'pending',
  p_limit integer default 20,
  p_after_submitted_at timestamptz default null,
  p_after_id uuid default null
)
returns table (
  id uuid,
  prompt_date date,
  prompt text,
  status text,
  submitted_at timestamptz,
  strokes jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    p_limit := 20;
  end if;
  if p_limit > 20 then
    p_limit := 20;
  end if;

  return query
  select de.id, dp.prompt_date, dp.prompt, de.status, de.submitted_at, de.strokes
  from public.daily_entries de
  join public.daily_prompts dp on dp.id = de.prompt_id
  where (p_prompt_date is null or dp.prompt_date = p_prompt_date)
    and (p_status is null or de.status = p_status)
    and de.submitted_at is not null   -- started-but-never-submitted never listed
    and (
      p_after_submitted_at is null
      or (de.submitted_at, de.id) > (p_after_submitted_at, p_after_id)
    )
  order by de.submitted_at asc, de.id asc
  limit p_limit;
end;
$$;
revoke execute on function public.admin_list_daily_entries(date, text, integer, timestamptz, uuid) from public, anon;
grant execute on function public.admin_list_daily_entries(date, text, integer, timestamptz, uuid) to authenticated;

-- 2. Guard admin_review_daily_entry: reject null p_approve and un-submitted entries.
create or replace function public.admin_review_daily_entry(p_entry_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
  v_submitted timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  if p_approve is null then
    raise exception 'approve flag required' using errcode = '22023';
  end if;

  select submitted_at into v_submitted
  from public.daily_entries where id = p_entry_id;
  if v_submitted is null then
    raise exception 'entry not submitted' using errcode = '22023';
  end if;

  update public.daily_entries
  set status = case when p_approve then 'approved' else 'rejected' end
  where id = p_entry_id;
  get diagnostics changed = row_count;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(),
          case when p_approve then 'approve_daily_entry' else 'reject_daily_entry' end,
          p_entry_id::text,
          jsonb_build_object('changed', changed));

  return jsonb_build_object('changed', changed);
end;
$$;
revoke execute on function public.admin_review_daily_entry(uuid, boolean) from public, anon;
grant execute on function public.admin_review_daily_entry(uuid, boolean) to authenticated;
