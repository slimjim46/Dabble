import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { CHANNEL_NAME, PAPER_SIZE } from '../lib/constants.js'
import { drawStroke } from '../lib/stroke.js'
import { rowToStroke } from '../lib/strokeCodec.js'

// The admin tool is a separate page with its own Supabase client: its session
// (a password-signed-in account, never anonymous) lives under a different
// storage key and never touches the drawing session's storage.
const ADMIN_STORAGE_KEY = 'doodlescrap-admin'
const PAGE = 50

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
        </nav>
        <div className="admin-actions">
          <button type="button" onClick={refresh} disabled={busy}>Refresh</button>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-notice">{notice}</p>}

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
    </div>
  )
}
