import { ensureAnonymousAuth, supabase } from '../lib/supabase.js'

/**
 * The token source for every rooms HTTP call and every WebSocket handshake.
 *
 * A fresh session per attempt, because the token may have expired while the
 * network was down, and exactly one refresh per readable 401 (a WebSocket
 * handshake 401 is invisible to the browser, which is why the pre-join probe
 * exists). This module pulls in `src/lib/supabase.js`, so it is never imported
 * by a plain-Node test — the tests exercise roomsWire.js's pure half instead.
 */
export function createRoomsAuth() {
  const readSession = async () => {
    if (!supabase) return null
    try {
      const { data } = await supabase.auth.getSession()
      if (data?.session) return data.session.access_token
      await ensureAnonymousAuth()
      const { data: again } = await supabase.auth.getSession()
      return again?.session?.access_token ?? null
    } catch {
      return null
    }
  }

  return {
    getToken: readSession,
    refresh: async () => {
      if (!supabase) return null
      try {
        const { data, error } = await supabase.auth.refreshSession()
        if (!error && data?.session) return data.session.access_token
      } catch {
        // fall through: no session to refresh, sign in again
      }
      const user = await ensureAnonymousAuth()
      if (!user) return null
      return readSession()
    },
  }
}
