import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[dabble] VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY are not set — ' +
      'realtime sync and persistence are disabled. Copy .env.example to .env and fill it in.',
  )
}

export const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 40 } },
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null

export function isSupabaseEnabled() {
  return supabase !== null
}

let authPromise = null

export function ensureAnonymousAuth() {
  if (!supabase) return Promise.resolve(null)
  if (!authPromise) {
    authPromise = (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session) return session.user
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) {
          console.error('[dabble] anonymous sign-in failed:', error.message)
          return null
        }
        return data.user ?? null
      } catch (error) {
        console.error('[dabble] anonymous sign-in failed:', error)
        return null
      }
    })().then((user) => {
      // A failed attempt (offline at load, etc.) must not stick: allow a retry.
      if (!user) authPromise = null
      return user
    })
  }
  return authPromise
}
