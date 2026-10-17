import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const POLL_MS = 30000

/**
 * Country leaderboard rows from get_country_leaderboard(). Polls only while the
 * panel is expanded AND the tab is visible, so a collapsed panel costs nothing.
 * Aggregates only (country level): the RPC never returns a user id. Failures
 * keep the last good value so the panel does not flicker.
 */
export function useCountryLeaderboard({ expanded, window: windowKey }) {
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!expanded || !supabase) return undefined
    let disposed = false
    let timer = 0

    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('get_country_leaderboard', { p_window: windowKey })
        if (disposed) return
        if (error) {
          setFailed(true)
          return
        }
        setFailed(false)
        setRows(Array.isArray(data) ? data : [])
      } catch {
        if (!disposed) setFailed(true)
      }
    }

    const schedule = () => {
      clearInterval(timer)
      timer = setInterval(load, POLL_MS)
    }

    setRows(null) // a new window: drop stale rows rather than show the old list
    load()
    schedule()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load()
        schedule()
      } else {
        clearInterval(timer)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [expanded, windowKey])

  return { rows, failed }
}
