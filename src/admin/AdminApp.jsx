import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { CHANNEL_NAME, PAPER_SIZE } from '../lib/constants.js'
import { drawStroke } from '../lib/stroke.js'
import { rowToStroke } from '../lib/strokeCodec.js'

// The admin tool is a separate page with its own Supabase client: its session
// (a password-signed-in account, never anonymous) lives under a different
// storage key and never touches the drawing session's storage.
const ADMIN_STORAGE_KEY = 'doodlescrap-admin'
const PAGE = 20

function makeClient() {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: {
      storageKey: ADMIN_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
}

function StrokePreview({ row, size = 200 }) {
  const ref = useRef(null)
  useEffect(() => {
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
    const scale = size / PAPER_SIZE
    ctx.scale(scale, scale)
    drawStroke(ctx, rowToStroke(row))
    ctx.restore()
  }, [row, size])
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 8 }} />
}

function timeOf(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

// ---- daily entry preview ----------------------------------------------------
// Entries store strokes as {color, width, points:[x,y,...]}. Convert to the
// stroke shape drawStroke expects, then render on a small canvas. Lazily
// mounted via IntersectionObserver so a long list does not render every
// preview at once.
function DailyEntryPreview({ strokes, size = 200 }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
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
    const scale = size / PAPER_SIZE
    ctx.scale(scale, scale)
    for (const s of strokes ?? []) {
      const points = []
      for (let i = 0; i < s.points.length; i += 2) {
        points.push({ x: s.points[i], y: s.points[i + 1] })
      }
      drawStroke(ctx, { color: s.color, width: s.width, points })
    }
    ctx.restore()
  }, [visible, strokes, size])
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 8 }} />
}

export default function AdminApp() {
  const client = useMemo(() => makeClient(), [])
  const [session, setSession] = useState(undefined) // undefined = loading
  const [access, setAccess] = useState('unknown') // unknown | allowed | denied
  const [rows, setRows] = useState([])
  const [tab, setTab] = useState('flagged')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const channelRef = useRef(null)

  // Daily entries state
  const [dailyEntries, setDailyEntries] = useState([])
  const [dailyCursor, setDailyCursor] = useState({ submittedAt: null, id: null })
  const [dailyHasMore, setDailyHasMore] = useState(true)
  const [dailyStatus, setDailyStatus] = useState('approved') // 'approved' | 'rejected'

  // /admin must not appear in search results (6.5).
  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'robots'
      meta.content = 'noindex, nofollow'
      document.head.appendChild(meta)
    }
    return () => meta.remove()
  }, [])

  useEffect(() => {
    if (!client) return undefined
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => subscription.unsubscribe()
  }, [client])

  const load = useCallback(
    async (which, activeSession) => {
      if (!client || !activeSession) return
      setBusy(true)
      setError('')
      if (which === 'daily') {
        const { data, error: rpcError } = await client.rpc('admin_list_daily_entries', {
          p_status: dailyStatus, p_limit: PAGE,
        })
        if (rpcError) {
          if (rpcError.code === '42501') setAccess('denied')
          else setError(rpcError.message || 'Failed to load')
          setDailyEntries([])
        } else {
          setAccess('allowed')
          setDailyEntries(Array.isArray(data) ? data : [])
          setDailyHasMore((data?.length ?? 0) >= PAGE)
          setDailyCursor(data?.length ? { submittedAt: data[data.length - 1].submitted_at, id: data[data.length - 1].id } : { submittedAt: null, id: null })
        }
        setBusy(false)
        return
      }
      const fn = which === 'flagged' ? 'admin_list_flagged' : 'admin_list_recent'
      const args = which === 'flagged'
        ? { p_limit: PAGE, p_offset: 0 }
        : { p_limit: PAGE, p_before: null }
      const { data, error: rpcError } = await client.rpc(fn, args)
      if (rpcError) {
        if (rpcError.code === '42501') setAccess('denied')
        else setError(rpcError.message || 'Failed to load')
        setRows([])
      } else {
        setAccess('allowed')
        setRows(Array.isArray(data) ? data : [])
      }
      setBusy(false)
    },
    [client],
  )

  // Probe admin access and load the current tab whenever the session changes.
  useEffect(() => {
    if (session === undefined) return
    if (!session) {
      setAccess('unknown')
      setRows([])
      setDailyEntries([])
      return
    }
    load(tab, session)
  }, [session, tab, load])

  const broadcastRemoved = useCallback(async (id, userId) => {
    try {
      if (!channelRef.current) {
        channelRef.current = client.channel(CHANNEL_NAME)
        await channelRef.current.subscribe()
      }
      await channelRef.current.send({
        type: 'broadcast',
        event: 'stroke_remove',
        payload: { id, userId },
      })
    } catch {
      // Receivers verify against the database anyway; the broadcast is a nudge.
    }
  }, [client])

  const refresh = useCallback(() => load(tab, session), [load, tab, session])

  const loadMoreDaily = useCallback(async () => {
    if (!client || !session || busy || !dailyHasMore) return
    setBusy(true)
    const { data, error: rpcError } = await client.rpc('admin_list_daily_entries', {
      p_status: dailyStatus, p_limit: PAGE,
      p_after_submitted_at: dailyCursor.submittedAt,
      p_after_id: dailyCursor.id,
    })
    if (!rpcError && Array.isArray(data) && data.length > 0) {
      setDailyEntries((prev) => [...prev, ...data])
      setDailyHasMore(data.length >= PAGE)
      setDailyCursor({ submittedAt: data[data.length - 1].submitted_at, id: data[data.length - 1].id })
    }
    setBusy(false)
  }, [client, session, busy, dailyHasMore, dailyCursor])

  const hideStroke = useCallback(
    async (row) => {
      setBusy(true)
      setError('')
      const { data, error: rpcError } = await client.rpc('admin_hide_stroke', { p_id: row.id })
      if (rpcError) setError(rpcError.message)
      else {
        setNotice('Stroke hidden')
        await broadcastRemoved(row.id, row.user_id)
      }
      await refresh()
      setBusy(false)
    },
    [client, refresh, broadcastRemoved],
  )

  const restoreStroke = useCallback(
    async (row) => {
      setBusy(true)
      setError('')
      const { error: rpcError } = await client.rpc('admin_restore_stroke', { p_id: row.id })
      if (rpcError) setError(rpcError.message)
      else setNotice('Stroke restored')
      await refresh()
      setBusy(false)
    },
    [client, refresh],
  )

  const banPlayer = useCallback(
    async (row, hideStrokes) => {
      const reason = window.prompt('Ban reason (optional, press Esc to cancel):')
      if (reason === null) return
      setBusy(true)
      setError('')
      const { error: rpcError } = await client.rpc('admin_ban_player', {
        p_user_id: row.user_id,
        p_hide_strokes: hideStrokes,
        p_reason: reason.trim() || null,
      })
      if (rpcError) setError(rpcError.message)
      else setNotice(hideStrokes ? 'Player banned, strokes hidden' : 'Player banned')
      await refresh()
      setBusy(false)
    },
    [client, refresh],
  )

  const unbanPlayer = useCallback(
    async (row) => {
      if (!window.confirm('Unban this player?')) return
      setBusy(true)
      setError('')
      const { error: rpcError } = await client.rpc('admin_unban_player', {
        p_user_id: row.user_id,
      })
      if (rpcError) setError(rpcError.message)
      else setNotice('Player unbanned')
      await refresh()
      setBusy(false)
    },
    [client, refresh],
  )

  const reviewDailyEntry = useCallback(
    async (entry, approve) => {
      setBusy(true)
      setError('')
      const { error: rpcError } = await client.rpc('admin_review_daily_entry', {
        p_entry_id: entry.id,
        p_approve: approve,
      })
      if (rpcError) setError(rpcError.message)
      else setNotice(approve ? 'Entry approved' : 'Entry rejected')
      await load('daily', session)
      setBusy(false)
    },
    [client, session, load, dailyStatus],
  )

  const sendMagicLink = useCallback(
    async (e) => {
      e.preventDefault()
      if (!client) return
      setError('')
      setBusy(true)
      const { error: otpError } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/admin` },
      })
      setBusy(false)
      if (otpError) setError(otpError.message)
      else setSent(true)
    },
    [client, email],
  )

  const signOut = useCallback(async () => {
    if (channelRef.current) {
      await channelRef.current.unsubscribe()
      channelRef.current = null
    }
    await client?.auth.signOut()
  }, [client])

  if (!client) {
    return <div className="admin-shell"><p className="admin-muted">VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.</p></div>
  }

  if (session === undefined) {
    return <div className="admin-shell"><p className="admin-muted">Checking session…</p></div>
  }

  if (!session) {
    return (
      <div className="admin-shell">
        <form className="admin-card" onSubmit={sendMagicLink}>
          <h1>DoodleScrap admin</h1>
          {sent ? (
            <p className="admin-muted">Check your inbox for the sign-in link.</p>
          ) : (
            <>
              <label className="admin-muted" htmlFor="admin-email">
                Sign in with a magic link
              </label>
              <input
                id="admin-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <button type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send link'}
              </button>
            </>
          )}
          {error && <p className="admin-error">{error}</p>}
        </form>
      </div>
    )
  }

  if (access === 'denied') {
    return (
      <div className="admin-shell">
        <div className="admin-card">
          <h1>DoodleScrap admin</h1>
          <p className="admin-muted">
            This account isn't an admin. Mark it in the dashboard (Auth → Users →
            Edit user → App metadata: <code>{`{"role": "admin"}`}</code>) and sign in again.
          </p>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <h1>DoodleScrap admin</h1>
        <nav className="admin-tabs">
          <button
            type="button"
            className={tab === 'flagged' ? 'admin-tab-active' : ''}
            onClick={() => setTab('flagged')}
          >
            Flagged
          </button>
          <button
            type="button"
            className={tab === 'recent' ? 'admin-tab-active' : ''}
            onClick={() => setTab('recent')}
          >
            Recent
          </button>
          <button
            type="button"
            className={tab === 'daily' ? 'admin-tab-active' : ''}
            onClick={() => setTab('daily')}
          >
            Daily entries
          </button>
        </nav>
        <div className="admin-actions">
          <button type="button" onClick={refresh} disabled={busy}>Refresh</button>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-notice">{notice}</p>}

      {tab === 'daily' ? (
        <>
          <div className="admin-tabs" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={dailyStatus === 'approved' ? 'admin-tab-active' : ''}
              onClick={() => setDailyStatus('approved')}
            >
              Approved
            </button>
            <button
              type="button"
              className={dailyStatus === 'rejected' ? 'admin-tab-active' : ''}
              onClick={() => setDailyStatus('rejected')}
            >
              Rejected
            </button>
          </div>
          {busy && dailyEntries.length === 0 && <p className="admin-muted">Loading…</p>}
          {!busy && dailyEntries.length === 0 && <p className="admin-muted">No {dailyStatus} daily entries.</p>}
          <div className="admin-list">
            {dailyEntries.map((entry) => (
              <article key={entry.id} className="admin-card admin-row">
                <DailyEntryPreview strokes={entry.strokes} />
                <div className="admin-meta">
                  <strong>{entry.prompt}</strong>
                  <span className="admin-muted">{timeOf(entry.submitted_at)}</span>
                  <span className="admin-muted">{entry.status}</span>
                  <div className="admin-actions">
                    {entry.status === 'rejected' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reviewDailyEntry(entry, true)}
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reviewDailyEntry(entry, false)}
                      >
                        Reject
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {dailyHasMore && dailyEntries.length > 0 && (
            <button type="button" onClick={loadMoreDaily} disabled={busy}>
              {busy ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      ) : (
        <>
          {busy && rows.length === 0 && <p className="admin-muted">Loading…</p>}
          {!busy && rows.length === 0 && <p className="admin-muted">Nothing here.</p>}

          <div className="admin-list">
            {rows.map((row) => (
              <article key={row.id} className="admin-card admin-row">
                <StrokePreview row={row} />
                <div className="admin-meta">
                  <strong title={row.user_id}>{row.user_name || 'unnamed'}</strong>
                  <span className="admin-muted">{timeOf(row.created_at)}</span>
                  {row.report_count > 0 && (
                    <span className="admin-reports">{row.report_count} report(s)</span>
                  )}
                  {row.hidden && (
                    <span className="admin-hidden">hidden{row.hidden_reason ? ` · ${row.hidden_reason}` : ''}</span>
                  )}
                  <div className="admin-actions">
                    {row.hidden ? (
                      <button type="button" onClick={() => restoreStroke(row)} disabled={busy}>
                        Restore
                      </button>
                    ) : (
                      <button type="button" onClick={() => hideStroke(row)} disabled={busy}>
                        Hide
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || !row.user_id}
                      onClick={() => banPlayer(row, true)}
                    >
                      Ban + hide strokes
                    </button>
                    <button
                      type="button"
                      disabled={busy || !row.user_id}
                      onClick={() => banPlayer(row, false)}
                    >
                      Ban only
                    </button>
                    <button
                      type="button"
                      disabled={busy || !row.user_id}
                      onClick={() => unbanPlayer(row)}
                    >
                      Unban
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
