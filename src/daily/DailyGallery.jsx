import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function DailyGallery() {
  const [winners, setWinners] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase
      .rpc('get_daily_winners', { p_limit: 20 })
      .then(({ data, error: err }) => {
        if (err) setError(err.message || 'Could not load gallery')
        else setWinners(Array.isArray(data) ? data : [])
        setLoading(false)
      })
  }, [])

  const share = useCallback(async (w) => {
    const url = w.image_path
      ? `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/snapshots/${w.image_path}`
      : null
    if (!url) return
    if (navigator.share) {
      try { await navigator.share({ title: 'DoodleScrap daily winner', url }) } catch {}
    } else {
      try { await navigator.clipboard.writeText(url) } catch {}
    }
  }, [])

  const back = useCallback(() => {
    window.history.pushState({}, '', '/daily')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])

  return (
    <div className="daily-screen">
      <div className="daily-top">
        <div className="daily-top-left">
          <span className="daily-prompt">Winners gallery</span>
        </div>
        <div className="daily-bar">
          <button type="button" className="daily-link" onClick={back}>Back</button>
        </div>
      </div>
      <div className="daily-gallery">
        {loading && <p className="daily-note">Loading…</p>}
        {error && <p className="daily-note">{error}</p>}
        {!loading && !error && winners.length === 0 && (
          <p className="daily-note">No winners yet. Check back after the first voting day.</p>
        )}
        {winners.map((w) => {
          const url = w.image_path
            ? `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/snapshots/${w.image_path}`
            : null
          return (
            <article key={w.prompt_date} className="daily-winner">
              {url && <img src={url} alt={`Winner for ${w.prompt_date}`} className="daily-winner-img" />}
              <div className="daily-winner-meta">
                <span className="daily-winner-prompt">{w.prompt}</span>
                <span className="daily-winner-votes">{w.votes} vote{w.votes !== 1 ? 's' : ''}</span>
                <span className="daily-winner-date">{w.prompt_date}</span>
                {url && (
                  <button type="button" className="daily-button" onClick={() => share(w)}>
                    Share
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
