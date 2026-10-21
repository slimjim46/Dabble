import { useCallback, useEffect, useRef, useState } from 'react'
import { getDailyVoteGrid, voteDailyEntry } from './dailyApi.js'

// Lazy canvas preview for a vote grid entry (mirrors AdminApp's DailyEntryPreview).
function EntryPreview({ strokes, size = 140 }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const observer = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); observer.disconnect() } },
      { threshold: 0.1 },
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.save()
    const scale = size / 2000
    ctx.scale(scale, scale)
    for (const s of strokes ?? []) {
      const points = []
      for (let i = 0; i < s.points.length; i += 2) points.push({ x: s.points[i], y: s.points[i + 1] })
      ctx.beginPath()
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (points.length === 1) { ctx.arc(points[0].x, points[0].y, s.width / 2, 0, Math.PI * 2); ctx.fill() }
      else {
        ctx.moveTo(points[0].x, points[0].y)
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
        ctx.stroke()
      }
    }
    ctx.restore()
  }, [visible, strokes, size])
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 8, cursor: 'pointer' }} />
}

export default function VoteGrid({ supabase }) {
  const [entries, setEntries] = useState([])
  const [votedIds, setVotedIds] = useState([])
  const [hasVoted, setHasVoted] = useState(false)
  const [remaining, setRemaining] = useState(3)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const res = await getDailyVoteGrid(supabase)
    if (res.error) {
      setError(res.error.message || 'Could not load vote grid')
      setLoading(false)
      return
    }
    setEntries(res.data?.entries ?? [])
    setVotedIds(res.data?.voted_entry_ids ?? [])
    setHasVoted(res.data?.has_voted ?? false)
    setRemaining(3 - (res.data?.voted_entry_ids?.length ?? 0))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const vote = useCallback(async (entryId) => {
    if (busy || remaining <= 0) return
    setBusy(true)
    const res = await voteDailyEntry(supabase, entryId)
    if (res.error) {
      setError(res.error.message || 'Vote failed')
    } else {
      setVotedIds((prev) => [...prev, entryId])
      setRemaining((r) => r - 1)
    }
    setBusy(false)
  }, [supabase, busy, remaining])

  if (loading) return <p className="daily-note">Loading entries…</p>
  if (error) return <p className="daily-note">{error}</p>
  if (entries.length === 0) return <p className="daily-note">No entries to vote on.</p>

  return (
    <div className="vote-grid">
      <p className="daily-note">Tap to vote · {remaining} vote{remaining !== 1 ? 's' : ''} left</p>
      <div className="vote-grid-items">
        {entries.map((e) => {
          const voted = votedIds.includes(e.id)
          return (
            <button
              key={e.id}
              type="button"
              className={`vote-item ${voted ? 'vote-item-voted' : ''}`}
              onClick={() => vote(e.id)}
              disabled={busy || voted || remaining <= 0}
            >
              <EntryPreview strokes={e.strokes} />
              {voted && <span className="vote-badge">✓</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

