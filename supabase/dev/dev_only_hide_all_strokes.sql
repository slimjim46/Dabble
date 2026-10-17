-- DEV ONLY. Never apply to production. Never part of `supabase db push`
-- (this file lives outside supabase/migrations/ on purpose).
--
-- Hides every currently visible stroke, so the dev canvas can be cleared after
-- a test run (clients cannot delete strokes by design, so test runs otherwise
-- fill the board with scribbles). Rows are hidden, not deleted, so they stay
-- available for inspection. Any signed-in user on dev may call it.

create or replace function public.dev_only_hide_all_strokes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  hidden_count integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  update public.strokes
  set hidden = true, hidden_reason = 'admin'
  where not hidden;
  get diagnostics hidden_count = row_count;

  return hidden_count;
end;
$$;
revoke execute on function public.dev_only_hide_all_strokes() from public, anon;
grant execute on function public.dev_only_hide_all_strokes() to authenticated;
