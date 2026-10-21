-- v2 Phase 5c-3: winner image path + public read RPC.

-- 1. Add image_path to daily_winners.
alter table public.daily_winners
  add column if not exists image_path text null;

-- 2. Replace the public select policy with a column-limited RPC.
--    entry_id must NOT be readable by anon/authenticated.
drop policy if exists daily_winners_select on public.daily_winners;
revoke select on public.daily_winners from anon, authenticated;

create or replace function public.get_daily_winners(p_limit integer default 10)
returns table (
  prompt_date date,
  prompt text,
  votes integer,
  image_path text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select dw.prompt_date, dp.prompt, dw.votes, dw.image_path
  from public.daily_winners dw
  join public.daily_prompts dp on dp.prompt_date = dw.prompt_date
  where dw.hidden = false
  order by dw.prompt_date desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
end;
$$;
revoke execute on function public.get_daily_winners(integer) from public, anon;
grant execute on function public.get_daily_winners(integer) to anon, authenticated;
