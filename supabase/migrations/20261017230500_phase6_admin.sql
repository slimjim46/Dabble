-- Phase 6.5: admin identity, audit log, and admin RPCs.
--
-- app_metadata can only be set by the service role or the dashboard (never by
-- the user, unlike user_metadata), and anonymous tokens carry role = 'anon'.

create or replace function public.is_admin()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
begin
  return coalesce(claims ->> 'role', '') = 'authenticated'
     and coalesce(claims -> 'app_metadata' ->> 'role', '') = 'admin';
end;
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid,
  action text not null,
  target text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from anon, authenticated;

create or replace function public.admin_list_flagged(
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  insert into public.admin_audit_log (admin_id, action, detail)
  values (auth.uid(), 'list_flagged',
          jsonb_build_object('limit', p_limit, 'offset', p_offset));
  return (
    select coalesce(jsonb_agg(q), '[]'::jsonb)
    from (
      select to_jsonb(s.*) as q
      from public.strokes s
      where s.report_count > 0 or s.hidden
      order by s.created_at desc
      limit p_limit offset p_offset
    ) sub
  );
end;
$$;

create or replace function public.admin_list_recent(
  p_limit integer default 50,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  insert into public.admin_audit_log (admin_id, action, detail)
  values (auth.uid(), 'list_recent',
          jsonb_build_object('limit', p_limit, 'before', p_before));
  return (
    select coalesce(jsonb_agg(q), '[]'::jsonb)
    from (
      select to_jsonb(s.*) as q
      from public.strokes s
      where p_before is null or s.created_at < p_before
      order by s.created_at desc
      limit p_limit
    ) sub
  );
end;
$$;

create or replace function public.admin_hide_stroke(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
  v_user_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  update public.strokes
  set hidden = true, hidden_reason = 'admin'
  where id = p_id
  returning user_id into v_user_id;
  get diagnostics changed = row_count;
  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'hide_stroke', p_id::text, jsonb_build_object('changed', changed));
  return jsonb_build_object('changed', changed, 'user_id', v_user_id);
end;
$$;

create or replace function public.admin_restore_stroke(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  update public.strokes
  set hidden = false, hidden_reason = null, reviewed = true
  where id = p_id;
  get diagnostics changed = row_count;
  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'restore_stroke', p_id::text, jsonb_build_object('changed', changed));
  return jsonb_build_object('changed', changed);
end;
$$;

create or replace function public.admin_ban_player(
  p_user_id uuid,
  p_hide_strokes boolean default false,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  banned_ok integer;
  hidden_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  update public.players
  set banned = true, banned_at = now(), ban_reason = p_reason
  where id = p_user_id;
  get diagnostics banned_ok = row_count;

  if p_hide_strokes then
    update public.strokes
    set hidden = true, hidden_reason = 'admin'
    where user_id = p_user_id and not hidden;
    get diagnostics hidden_count = row_count;
  end if;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'ban_player', p_user_id::text,
          jsonb_build_object(
            'hide_strokes', p_hide_strokes,
            'reason', p_reason,
            'strokes_hidden', hidden_count
          ));
  return jsonb_build_object('banned', banned_ok, 'strokes_hidden', hidden_count);
end;
$$;

create or replace function public.admin_unban_player(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  update public.players
  set banned = false, banned_at = null, ban_reason = null
  where id = p_user_id;
  get diagnostics changed = row_count;

  insert into public.admin_audit_log (admin_id, action, target, detail)
  values (auth.uid(), 'unban_player', p_user_id::text,
          jsonb_build_object('changed', changed));
  return jsonb_build_object('unbanned', changed);
end;
$$;

revoke execute on function public.admin_list_flagged(integer, integer) from public, anon;
revoke execute on function public.admin_list_recent(integer, timestamptz) from public, anon;
revoke execute on function public.admin_hide_stroke(uuid) from public, anon;
revoke execute on function public.admin_restore_stroke(uuid) from public, anon;
revoke execute on function public.admin_ban_player(uuid, boolean, text) from public, anon;
revoke execute on function public.admin_unban_player(uuid) from public, anon;
grant execute on function public.admin_list_flagged(integer, integer) to authenticated;
grant execute on function public.admin_list_recent(integer, timestamptz) to authenticated;
grant execute on function public.admin_hide_stroke(uuid) to authenticated;
grant execute on function public.admin_restore_stroke(uuid) to authenticated;
grant execute on function public.admin_ban_player(uuid, boolean, text) to authenticated;
grant execute on function public.admin_unban_player(uuid) to authenticated;
