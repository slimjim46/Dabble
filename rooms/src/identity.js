// Server-authoritative identity: the player's own rows.name / last_country /
// banned, fetched from Supabase with the user's own JWT (the players_select_own
// RLS policy allows it) plus the public anon key — no service key in the
// Worker. Client messages never carry identity.
//
// Fail open as "Guest" on any Supabase error or a > 2 s timeout (availability
// first; the fallback grants nothing but a display name) and count it.
// Known gap: a player banned after connecting keeps their seat until they
// reconnect — bans are checked only here, at connect time.
import { FALLBACK_NAME, IDENTITY_CACHE_MS, IDENTITY_TIMEOUT_MS } from './config.js'
import { logEvent } from './log.js'

// 60 s cache per user, per isolate.
const cache = new Map()

// Counts survive within one isolate only; enough to see an outage in logs.
let fallbackCount = 0
let missingCount = 0

export function identityStats() {
  return { fallback: fallbackCount, missing: missingCount, cached: cache.size }
}

/**
 * @returns {Promise<{name: string, country: string|null, banned: boolean}>}
 */
export async function fetchIdentity(userId, jwt, env) {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_MS) return hit.value

  const value = await load(userId, jwt, env)
  if (value) {
    cache.set(userId, { at: Date.now(), value })
    if (cache.size > 4096) cache.clear() // isolate-local; crude is fine
  }
  return value
}

async function load(userId, jwt, env) {
  if (!env.SUPABASE_ANON_KEY) {
    // Config bug, not a network error: never fall through to a broken call.
    logEvent('identity_misconfigured')
    return fallback()
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS)
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/players?id=eq.${encodeURIComponent(userId)}&select=name,last_country,banned`
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      logEvent('identity_error', { status: res.status })
      return fallback()
    }
    const rows = await res.json()
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) {
      // Legacy user with no players row (pre-backfill edge): behave as Guest,
      // but don't cache — the row may appear as soon as they use the app.
      missingCount += 1
      logEvent('identity_missing', { n: missingCount })
      return { name: FALLBACK_NAME, country: null, banned: false }
    }
    const country = typeof row.last_country === 'string' && /^[A-Z]{2}$/.test(row.last_country) ? row.last_country : null
    return {
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 24) : FALLBACK_NAME,
      country,
      banned: row.banned === true,
    }
  } catch {
    // Network error or 2 s timeout: fail open as Guest, counted.
    return fallback()
  } finally {
    clearTimeout(timer)
  }
}

function fallback() {
  fallbackCount += 1
  logEvent('identity_fallback', { n: fallbackCount })
  return { name: FALLBACK_NAME, country: null, banned: false }
}
