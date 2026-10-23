import { useCallback, useEffect, useState } from 'react'
import { navigate } from '../lib/navigation.js'
import { supabase } from '../lib/supabase.js'
import { getMyEntry, getTodayPrompt } from './dailyApi.js'
import { DAILY_GALLERY_PATH, DAILY_GALLERY_VOTE_PATH, DAILY_PATH, dailyGalleryTab } from './dailyRoute.js'
import VoteGrid from './VoteGrid.jsx'
import './daily.css'

function VoteTab({ onBack }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!supabase) {
        setState({ status: 'error' })
        return
      }
      try {
        const prompt = await getTodayPrompt(supabase)
        if (cancelled) return
        if (!prompt) {
          setState({ status: 'not_submitted' })
          return
        }
        const entry = await getMyEntry(supabase, prompt.id)
        if (cancelled) return
        setState({ status: entry?.submitted_at ? 'submitted' : 'not_submitted' })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (state.status === 'loading') {
    return (
      <div className="daily-vote-section">
        <p className="daily-note">Loading…</p>
      </div>
    )
  }
  if (state.status === 'not_submitted') {
    return (
      <div className="daily-vote-section">
        <div className="daily-vote-empty">
          <p className="daily-note daily-note-inline">Draw today's prompt first to vote.</p>
          <button type="button" className="daily-button" onClick={onBack}>Go to Daily</button>
        </div>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="daily-vote-section">
        <p className="daily-note">Could not load the vote grid.</p>
      </div>
    )
  }
  return (
    <div className="daily-vote-section">
      <h2 className="daily-heading">Vote for your favourites</h2>
      <p className="daily-note daily-note-inline">Entry in! Vote for your favourites.</p>
      <p className="daily-note daily-note-inline">Winners are announced a couple of days after voting.</p>
      <VoteGrid supabase={supabase} />
    </div>
  )
}

export default function DailyGallery() {
  const [tab, setTab] = useState(() => dailyGalleryTab(window.location.search))
  const [winners, setWinners] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const sync = () => setTab(dailyGalleryTab(window.location.search))
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  const switchTab = useCallback((next) => {
    if (next === tab) return
    navigate(next === 'vote' ? DAILY_GALLERY_VOTE_PATH : DAILY_GALLERY_PATH)
  }, [tab])

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
    navigate(DAILY_PATH)
  }, [])

  return (
    <div className="daily-screen">
      <div className="daily-top">
        <div className="daily-top-left">
          <div className="daily-tabs" role="tablist" aria-label="Daily gallery">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'vote'}
              className="daily-link daily-tab"
              onClick={() => switchTab('vote')}
            >
              Vote
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'winners'}
              className="daily-link daily-tab"
              onClick={() => switchTab('winners')}
            >
              Winners
            </button>
          </div>
        </div>
        <div className="daily-bar">
          <button type="button" className="daily-link" onClick={back}>Back</button>
        </div>
      </div>
      {tab === 'vote' ? <VoteTab onBack={back} /> : (
      <div className="daily-gallery">
        {loading && <p className="daily-note">Loading…</p>}
        {error && <p className="daily-note">{error}</p>}
        {!loading && !error && winners.length === 0 && (
          <p className="daily-note">No winners yet. Winners are announced a couple of days after voting.</p>
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
      )}
    </div>
  )
}
