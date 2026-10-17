import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const POLL_MS = 20000

/**
 * Country count from get_live_stats(), polled every 20 s while visible.
 * Purely cosmetic: failures keep the last value (no flicker) and null means
 * "no stats yet", so the caller can fall back to the presence-only text.
 */
export function useLiveStats() {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    if (!supabase) return undefined
    let disposed = false
    let timer = 0

    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('get_live_stats')
        if (disposed || error || !data) return
        if (typeof data.countries === 'number') setStats({ countries: data.countries })
      } catch {
        // stats are cosmetic
      }
    }

    const schedule = () => {
      clearInterval(timer)
      timer = setInterval(load, POLL_MS)
    }

    load()
    schedule()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load()
        schedule()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return stats
}
