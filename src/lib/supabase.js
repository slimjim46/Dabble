import { createClient } from '@supabase/supabase-js'

import { ensureCaptchaToken } from './turnstile.js'

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
        // Turnstile runs before the request, never after it: the token has to
        // be in hand before signInAnonymously, or the sign-in is rejected.
        // Without a configured site key none of it runs at all.
        const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY
        const captchaToken = siteKey ? await ensureCaptchaToken(siteKey) : null
        // Key configured but no token: the request would be rejected anyway,
        // so fail now (the caller shows "not saving") instead of sending a
        // sign-in that cannot succeed. Bounded waits keep this from hanging.
        if (siteKey && !captchaToken) return null
        const { data, error } = await supabase.auth.signInAnonymously(
          captchaToken ? { options: { captchaToken } } : undefined,
        )
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
