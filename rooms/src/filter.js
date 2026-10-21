// The blocked-word filter for custom room words (v2 Phase 4b).
//
// The list lives in public.blocked_terms (owner-supplied, loaded by
// scripts/load-blocked-terms.mjs); the Worker never holds a copy and never
// logs or returns a word. wordAllowed() is the single check, made with the
// player's own JWT (role authenticated) and the public anon key — no service
// key. It runs when the host sets words, never at pick time.
//
// Fail CLOSED: a word that cannot be verified (Supabase down, timeout) is
// treated as not allowed, because a word is shown publicly at reveal and an
// unverified word must not slip through. The game itself still runs on the
// curated list, so an outage only disables custom words, not the room.
import { WORD_FILTER_TIMEOUT_MS } from './config.js'
import { logEvent } from './log.js'

/**
 * @returns {Promise<boolean>} true when the word is allowed.
 */
export async function wordAllowed(word, jwt, env) {
  if (!env.SUPABASE_ANON_KEY) {
    logEvent('word_filter_misconfigured')
    return false
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WORD_FILTER_TIMEOUT_MS)
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/rpc/is_word_allowed`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_word: word }),
      signal: controller.signal,
    })
    if (!res.ok) {
      logEvent('word_filter_error', { status: res.status })
      return false
    }
    return (await res.json()) === true
  } catch {
    // Network error or timeout: fail closed, counted.
    logEvent('word_filter_unavailable')
    return false
  } finally {
    clearTimeout(timer)
  }
}
