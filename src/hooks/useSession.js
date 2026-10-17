import { useEffect, useState } from 'react'
import { beaconHeartbeat, getSession, sendHeartbeat, startSession } from '../lib/session.js'
import { ensureAnonymousAuth, supabase } from '../lib/supabase.js'

const HEARTBEAT_MS = 30000

/**
 * Starts the server session after anonymous auth, then heartbeats every 30 s
 * while the tab is visible. Hidden tabs pause; becoming visible beats
 * immediately. Returns { sessionId, country } (country may be null).
 */
export function useSession() {
  const [session, setSession] = useState({ sessionId: null, country: null })

  useEffect(() => {
    if (!supabase) return undefined
    let disposed = false
    let timer = 0

    const beat = () => {
      if (document.visibilityState === 'visible') sendHeartbeat()
    }

    const start = async () => {
      const user = await ensureAnonymousAuth()
      if (!user || disposed) return
      const info = await startSession(supabase)
      if (!info || disposed) return
      setSession({ ...getSession() })
      timer = setInterval(beat, HEARTBEAT_MS)
    }
    start()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') beat()
    }
    const onPageHide = () => beaconHeartbeat()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  return session
}
