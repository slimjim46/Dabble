-- Phase 4.3: aggregate-only stats RPCs.
--
-- Both are security definer with an empty search_path, executable only by
-- authenticated, and return aggregates only — never a user id or a session
-- row. "Online" = sessions seen in the last 60 seconds, distinct by user_id.
--
-- Playtime is last_seen - login_time (there is no duration column). A session
-- is attributed in full to the country it was opened in, and counts in a
-- window when it was last seen inside that window; a session that started
-- before the window therefore contributes its full playtime. Documented
-- trade-off: cheap and index-friendly beats subtleties nobody can see.

create or replace function public.get_live_stats()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with live as (
    select user_id, country_code
    from public.sessions
    where last_seen > now() - interval '60 seconds'
  ),
  per_country as (
    select country_code, count(distinct user_id) as players
    from live
    where country_code is not null
    group by country_code
  ),
  top as (
    select country_code, players
    from per_country
    order by players desc, country_code
    limit 5
  )
  select jsonb_build_object(
    'online', (select count(distinct user_id) from live),
    'countries', (select count(*) from per_country),
    'top_countries', coalesce(
      (select jsonb_agg(jsonb_build_object('code', country_code, 'count', players))
       from top),
      '[]'::jsonb
    )
  );
$$;
revoke execute on function public.get_live_stats() from public, anon;
grant execute on function public.get_live_stats() to authenticated;

create or replace function public.get_country_leaderboard(p_window text default '24h')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  win interval;
begin
  if p_window is null or p_window not in ('24h', '7d', 'all') then
    raise exception 'invalid window' using errcode = '22023';
  end if;

  win := case p_window
    when '24h' then interval '24 hours'
    when '7d'  then interval '7 days'
    else null
  end;

  return (
    with win_sessions as (
      select user_id, country_code, last_seen - login_time as playtime
      from public.sessions
      where country_code is not null
        and (win is null or last_seen > now() - win)
    ),
    countries as (
      select country_code,
             sum(playtime) as playtime,
             count(distinct user_id) as players
      from win_sessions
      group by country_code
    ),
    country_users as (
      select distinct country_code, user_id from win_sessions
    ),
    strokes_by_country as (
      select cu.country_code, count(distinct st.id) as strokes
      from country_users cu
      join public.strokes st on st.user_id = cu.user_id
      where win is null or st.created_at > now() - win
      group by cu.country_code
    )
    select coalesce(jsonb_agg(to_jsonb(top)), '[]'::jsonb)
    from (
      select c.country_code as code,
             extract(epoch from c.playtime)::bigint as playtime_seconds,
             coalesce(s.strokes, 0) as strokes,
             c.players as players
      from countries c
      left join strokes_by_country s using (country_code)
      order by c.playtime desc, c.country_code
      limit 20
    ) top
  );
end;
$$;
revoke execute on function public.get_country_leaderboard(text) from public, anon;
grant execute on function public.get_country_leaderboard(text) to authenticated;
