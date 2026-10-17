-- Phase 6.3: names.
--
-- The word list is supplied by the owner and loaded by
-- scripts/load-blocked-terms.mjs (from an uncommitted local file); this
-- migration only creates the table and the matching logic.

create table if not exists public.blocked_terms (
  term text primary key,
  severity text not null check (severity in ('substring', 'whole_word'))
);
alter table public.blocked_terms enable row level security;
revoke all on table public.blocked_terms from anon, authenticated;

-- Normalisation shared by names and terms so both sides compare identically:
-- NFKC, lowercase, look-alike folding (0->o, 1/l->i, 3->e, 4->a, 5/s/$->s,
-- @->a), then strip spaces and punctuation.
create or replace function public.dabble_normalize_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    translate(lower(normalize(trim(p), NFKC)), '01345$@l', 'oieassai'),
    '[[:space:][:punct:]]', '', 'g'
  );
$$;
revoke execute on function public.dabble_normalize_name(text) from public;

create or replace function public.is_name_allowed(p_name text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  trimmed text := coalesce(p_name, '');
  norm text;
  norm_term text;
  rec record;
begin
  if char_length(trimmed) < 1 or char_length(trimmed) > 24 then
    return false;
  end if;

  -- Control characters, zero-width characters, bidi overrides.
  if trimmed ~ '[[:cntrl:]]' then
    return false;
  end if;
  if trimmed ~ E'[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    return false;
  end if;

  norm := public.dabble_normalize_name(trimmed);

  for rec in select bt.term, bt.severity from public.blocked_terms bt loop
    norm_term := public.dabble_normalize_name(rec.term);
    if norm_term = '' then
      continue;
    end if;
    if rec.severity = 'substring' then
      if position(norm_term in norm) > 0 then
        return false;
      end if;
    else
      -- whole_word: match only against whole tokens of the original name, so
      -- an innocent name containing a banned fragment is not blocked.
      if exists (
        select 1
        from unnest(regexp_split_to_array(trimmed, '[^[:alnum:]]+')) as t(tok)
        where t.tok <> ''
          and public.dabble_normalize_name(t.tok) = norm_term
      ) then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;
revoke execute on function public.is_name_allowed(text) from public, anon;
grant execute on function public.is_name_allowed(text) to authenticated;

-- Rename history for the rate limit (5 per hour). Written only by set_my_name.
create table if not exists public.name_changes (
  player_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists name_changes_player_idx
  on public.name_changes (player_id, created_at);
alter table public.name_changes enable row level security;
revoke all on table public.name_changes from anon, authenticated;

create or replace function public.set_my_name(new_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  trimmed text := coalesce(new_name, '');
  recent integer;
  per_hour integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if not public.is_name_allowed(trimmed) then
    raise exception 'name_not_allowed' using errcode = '22023';
  end if;

  select renames_per_hour into per_hour from public.dabble_limits();
  select count(*) into recent
  from public.name_changes
  where player_id = uid
    and created_at > now() - interval '1 hour';
  if recent >= per_hour then
    raise exception 'too many name changes' using errcode = 'PT429';
  end if;

  update public.players
  set name = trimmed
  where id = uid;

  insert into public.name_changes (player_id) values (uid);
  delete from public.name_changes
  where created_at < now() - interval '1 day';
end;
$$;
revoke execute on function public.set_my_name(text) from public, anon;
grant execute on function public.set_my_name(text) to authenticated;
