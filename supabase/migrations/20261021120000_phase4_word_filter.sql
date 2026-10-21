-- v2 Phase 4: word filter for custom room words.
--
-- The blocked list stays in public.blocked_terms (owner-supplied, loaded by
-- scripts/load-blocked-terms.mjs) and is never copied into the Worker, logged,
-- or shipped in a deploy artifact. This is the one call the Worker makes to
-- check a custom word, using the player's own JWT (role authenticated) — no
-- service key. It is SECURITY DEFINER so it can read blocked_terms (RLS on,
-- no grants) exactly like set_my_name's inner is_name_allowed, but with the
-- game's own rule: a single lowercase a-z token, 3..40 characters
-- (MAX_WORD_LENGTH = 40 in rooms/src/config.js; hints and the close-distance
-- rule need at least 3).

create or replace function public.is_word_allowed(p_word text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  trimmed text := coalesce(p_word, '');
  norm text;
  norm_term text;
  rec record;
begin
  -- Shape first: one lowercase ASCII token, 3..40 chars. This mirrors the wire
  -- and hint assumption that words are single lowercase tokens.
  if trimmed !~ '^[a-z]{3,40}$' then
    return false;
  end if;

  -- Same hostile-content guards as names.
  if trimmed ~ '[[:cntrl:]]' then
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
      if norm = norm_term then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;
revoke execute on function public.is_word_allowed(text) from public, anon;
grant execute on function public.is_word_allowed(text) to authenticated;
