import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CHANNEL_NAME,
  CURSOR_FLUSH_MS,
  LIVE_FLUSH_MS,
  MAX_LIVE_POINTS,
  REMOTE_POINTS_PER_MINUTE,
  REMOTE_STARTS_PER_WINDOW,
  REMOTE_STARTS_WINDOW_MS,
} from '../lib/constants.js'
import { saveIdentity } from '../lib/identity.js'
import { createPersistQueue } from '../lib/persistQueue.js'
import {
  fetchLatestSnapshot,
  fetchLatestStrokes,
  fetchStrokesSince,
  hideStroke,
  isStrokeVisible,
  loadSnapshotImage,
  snapshotImageUrl,
} from '../lib/strokeApi.js'
import {
  broadcastToStroke,
  decodePoints,
  encodePoints,
  newStrokeId,
  quantize,
  strokeToBroadcast,
} from '../lib/strokeCodec.js'
import { ensureAnonymousAuth, supabase } from '../lib/supabase.js'
import {
  MAX_LIVE_BATCH_NUMBERS,
  parseCursor,
  parseStrokeCancel,
  parseStrokeEnd,
  parseStrokePoints,
  parseStrokeRemove,
  parseStrokeStart,
  sanitizePresence,
} from '../lib/wire.js'

const BROADCAST_EVENTS = [
  'stroke_start',
  'stroke_points',
  'stroke_end',
  'stroke_cancel',
  'stroke_remove',
  'cursor',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sendBroadcast(s, event, payload) {
  if (!s.channel || !s.subscribed || s.banned) return
  Promise.resolve(s.channel.send({ type: 'broadcast', event, payload })).catch(() => {})
}

async function hideWithRetry(id) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await hideStroke(id)
      return true
    } catch (error) {
      if (/^(22|23|42)/.test(String(error?.code ?? ''))) {
        console.error('[doodlescrap] could not remove stroke', error)
        return false
      }
      await sleep(1000 * 2 ** attempt)
    }
  }
  return false
}

/**
 * Everything network-related for the canvas:
 *  - anonymous auth (the auth user id becomes the stroke owner id)
 *  - one Broadcast channel for live strokes + cursors, Presence for who's online
 *  - join order: subscribe + buffer -> fetch history -> merge -> replay buffer
 *  - batched sending (live points ~70ms, cursor ~130ms)
 *  - background persistence with retries, and catch-up after reconnects
 *
 * Remote data goes straight into `store` / `cursors` (no React state) and
 * `onVisualChange` asks the canvas to redraw. Returns a stable `api` object
 * for the drawing code to call, plus a few values for the status pill.
 */
export function useRealtimeCanvas({
  identityRef,
  store,
  cursors,
  name,
  color,
  country,
  onVisualChange,
  loadBase,
}) {
  const [status, setStatus] = useState(supabase ? 'connecting' : 'offline')
  const [online, setOnline] = useState(1)
  const [saving, setSaving] = useState(true)
  const [banned, setBanned] = useState(false)
  const [nameRejected, setNameRejected] = useState(false)

  const ref = useRef(null)
  if (!ref.current) {
    ref.current = {
      key: newStrokeId(), // unique per tab, used for presence + cursors
      channel: null,
      subscribed: false,
      live: null, // { id, seq } of our own in-progress stroke
      pending: [], // flat [x, y, ...] waiting for the next flush
      cursor: null,
      cursorDirty: false,
      presence: { name, color, country },
      watermark: null, // created_at of the newest row we've seen
      banned: false, // set after sign-in when players.banned is true
      queue: createPersistQueue({
        getUserId: async () => (await ensureAnonymousAuth())?.id ?? null,
      }),
    }
  }

  // ---- API used by the drawing code (stable identity) ----------------------
  const api = useMemo(() => {
    const s = ref.current
    return {
      strokeStart(stroke) {
        s.live = { id: stroke.id, seq: 0 }
        s.pending = []
        sendBroadcast(s, 'stroke_start', {
          k: s.key,
          id: stroke.id,
          userId: stroke.userId,
          userName: stroke.userName,
          color: stroke.color,
          width: stroke.width,
          pts: encodePoints(stroke.points),
        })
      },

      strokePoint(point) {
        if (!s.live) return
        s.pending.push(quantize(point.x), quantize(point.y))
      },

      // Local rendering already happened; this broadcasts + saves in background.
      strokeEnd(stroke) {
        if (s.live?.id === stroke.id) s.live = null
        s.pending = []
        sendBroadcast(s, 'stroke_end', { k: s.key, stroke: strokeToBroadcast(stroke) })
        if (supabase && !s.banned) s.queue.add(stroke)
      },

      strokeCancel(id) {
        if (s.live?.id === id) s.live = null
        s.pending = []
        sendBroadcast(s, 'stroke_cancel', { k: s.key, id })
      },

      removeStroke(id) {
        if (!supabase) return
        const userId = identityRef.current.id
        // Never reached the database: nothing to hide, just tell everyone.
        if (s.queue.cancel(id)) {
          sendBroadcast(s, 'stroke_remove', { id, userId })
          return
        }
        // Hide in the DB first, then broadcast, so receivers can verify it.
        hideWithRetry(id).then((ok) => {
          if (ok) sendBroadcast(s, 'stroke_remove', { id, userId })
        })
      },

      cursor(x, y) {
        s.cursor = { x, y }
        s.cursorDirty = true
      },
    }
  }, [identityRef])

  // ---- keep Presence in sync with name / color / country -------------------
  useEffect(() => {
    const s = ref.current
    s.presence = { name, color, country }
    if (!s.channel || !s.subscribed) return undefined
    const timer = setTimeout(() => {
      Promise.resolve(s.channel?.track(s.presence)).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [name, color, country])

  // ---- anonymous auth ------------------------------------------------------
  useEffect(() => {
    if (!supabase) return undefined
    let cancelled = false

    ;(async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        const user = await ensureAnonymousAuth()
        if (cancelled) return
        if (user) {
          const previous = identityRef.current
          if (previous.id !== user.id) {
            identityRef.current = { ...previous, id: user.id }
            saveIdentity(identityRef.current)
            store.reassignUser(previous.id, user.id)
          }
          setSaving(true)
          // Keep the stored name in step with the local guest name (6.3).
          // Only a genuine rejection (blocked name) surfaces a notice; a
          // network hiccup here is not the visitor's problem.
          supabase
            .rpc('set_my_name', { new_name: identityRef.current.name })
            .then(({ error }) => {
              if (!cancelled && error?.code === '22023') setNameRejected(true)
            })
            .catch(() => {})
          // Quiet banned feedback: no broadcasts, no saves, muted notice.
          supabase
            .from('players')
            .select('banned')
            .eq('id', user.id)
            .maybeSingle()
            .then(({ data, error }) => {
              if (cancelled || error || !data?.banned) return
              ref.current.banned = true
              setBanned(true)
            })
            .catch(() => {})
          return
        }
        await sleep(2000 * (attempt + 1))
      }
      if (!cancelled) setSaving(false)
    })()

    return () => {
      cancelled = true
    }
  }, [identityRef, store])

  // ---- channel lifecycle ---------------------------------------------------
  useEffect(() => {
    if (!supabase) return undefined
    const s = ref.current

    // React StrictMode mounts, unmounts and re-mounts effects immediately in dev.
    // supabase-js hands back a still-closing channel for the same topic, which
    // then rejects new listeners. Deferring one tick lets the throwaway mount
    // cancel itself before any channel exists.
    function boot() {
      let disposed = false
      let buffering = true // hold broadcasts until history is merged
      let joined = false
      let resyncing = false
      let hiddenAt = 0
      let retryTimer = 0
      const buffer = []
      const verifyTimers = new Set()

      // Broadcasts are not validated by the database, so receivers protect
      // themselves: per-sender start and point budgets, silently enforced.
      const senderStats = new Map() // sender key -> { starts: number[], points, pointsAt }
      function allowStart(key) {
        const now = Date.now()
        let stats = senderStats.get(key)
        if (!stats) {
          stats = { starts: [], points: 0, pointsAt: now }
          if (senderStats.size > 500) senderStats.clear()
          senderStats.set(key, stats)
        }
        stats.starts = stats.starts.filter((t) => now - t < REMOTE_STARTS_WINDOW_MS)
        if (stats.starts.length >= REMOTE_STARTS_PER_WINDOW) return false
        stats.starts.push(now)
        return true
      }
      function allowPointNumbers(key, count) {
        const stats = senderStats.get(key)
        if (!stats) return false
        const now = Date.now()
        if (now - stats.pointsAt >= 60000) {
          stats.pointsAt = now
          stats.points = 0
        }
        if (stats.points + count > REMOTE_POINTS_PER_MINUTE) return false
        stats.points += count
        return true
      }

      const channel = supabase.channel(CHANNEL_NAME, {
        config: { broadcast: { self: false }, presence: { key: s.key } },
      })
      s.channel = channel

      // -- incoming broadcasts --------------------------------------------------
      function dispatch(event, payload) {
        switch (event) {
          case 'stroke_start': {
            const p = parseStrokeStart(payload)
            if (!p || p.k === s.key || store.has(p.id)) return
            if (!allowStart(p.k)) return
            const points = decodePoints(p.pts)
            if (!store.startLive(p.k, {
              id: p.id,
              userId: p.userId,
              userName: p.userName,
              color: p.color,
              width: p.width,
              points,
            })) return
            cursors.update(p.k, points[0].x, points[0].y)
            break
          }

          case 'stroke_points': {
            const p = parseStrokePoints(payload)
            if (!p || p.k === s.key) return
            const live = store.getLive(p.k)
            if (!live || live.id !== p.id || p.seq <= live.seq) return
            if (live.points.length >= MAX_LIVE_POINTS + 50) return
            if (!allowPointNumbers(p.k, p.pts.length)) return
            const points = decodePoints(p.pts)
            for (const point of points) live.points.push(point)
            live.seq = p.seq
            live.updatedAt = performance.now()
            const last = points[points.length - 1]
            cursors.update(p.k, last.x, last.y)
            break
          }

          case 'stroke_end': {
            const p = parseStrokeEnd(payload)
            if (!p || p.k === s.key) return
            store.endLive(p.k, p.stroke.id)
            const stroke = broadcastToStroke(p.stroke)
            store.add(stroke)
            const last = stroke.points[stroke.points.length - 1]
            cursors.update(p.k, last.x, last.y)
            break
          }

          case 'stroke_cancel': {
            const p = parseStrokeCancel(payload)
            if (!p || p.k === s.key) return
            store.endLive(p.k, p.id)
            break
          }

          case 'stroke_remove': {
            const p = parseStrokeRemove(payload)
            if (!p) return
            // Broadcasts can be spoofed. Only drop the stroke if the database
            // agrees it's gone (the sender hides it there before broadcasting).
            const timer = setTimeout(async () => {
              verifyTimers.delete(timer)
              if (disposed) return
              const stroke = store.get(p.id)
              if (!stroke || stroke.userId !== p.userId) return
              if (await isStrokeVisible(p.id)) return
              if (disposed) return
              store.remove(p.id)
              onVisualChange()
            }, 400)
            verifyTimers.add(timer)
            return
          }

          case 'cursor': {
            const p = parseCursor(payload)
            if (!p || p.k === s.key) return
            cursors.update(p.k, p.x, p.y)
            break
          }

          default:
            return
        }
        onVisualChange()
      }

      const receive = (event) => ({ payload }) => {
        if (buffering) {
          if (buffer.length < 2000) buffer.push([event, payload])
          return
        }
        // A malformed or hostile broadcast is dropped, never thrown.
        try {
          dispatch(event, payload)
        } catch (error) {
          console.warn('[doodlescrap] dropped bad broadcast', event, error)
        }
      }
      for (const event of BROADCAST_EVENTS) {
        channel.on('broadcast', { event }, receive(event))
      }

      // -- presence -------------------------------------------------------------
      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const keys = Object.keys(state)
        for (const key of keys) {
          if (key === s.key) continue
          const meta = sanitizePresence(state[key]?.[0])
          cursors.setInfo(key, meta.name, meta.color, meta.country)
        }
        setOnline(Math.max(1, keys.length))
        onVisualChange()
      })
      channel.on('presence', { event: 'leave' }, ({ key }) => {
        if (!key || key === s.key) return
        cursors.remove(key)
        store.endLive(key)
        onVisualChange()
      })

      // -- history / catch-up ---------------------------------------------------
      //
      // First join prefers the baked snapshot: one PNG (everything older than
      // the snapshot cutoff) plus the visible strokes created at/after its
      // watermark. gte is fine — redrawing an opaque stroke is harmless. Any
      // problem (no snapshot, image error/timeout, query error) silently falls
      // back to loading the full stroke list, so the canvas always loads.
      async function loadSnapshot() {
        try {
          const snapshot = await fetchLatestSnapshot()
          if (disposed || !snapshot) return false
          const url = snapshotImageUrl(snapshot.image_path)
          if (!url) return false
          const image = await loadSnapshotImage(url)
          if (disposed) return false
          if (loadBase) loadBase(image) // paint the baked canvas before the rest
          const result = await fetchStrokesSince(snapshot.last_stroke_created_at)
          if (disposed) return false
          s.watermark = result.lastCreatedAt
          store.addMany(result.strokes)
          return true
        } catch (error) {
          if (!disposed) console.warn('[doodlescrap] snapshot unavailable:', error?.message ?? error)
          return false
        }
      }

      async function loadHistory() {
        if (s.watermark) {
          const result = await fetchStrokesSince(s.watermark)
          if (disposed) return
          if (result.lastCreatedAt) s.watermark = result.lastCreatedAt
          store.addMany(result.strokes)
          return
        }

        if (await loadSnapshot()) return

        const result = await fetchLatestStrokes()
        if (disposed) return
        if (result.lastCreatedAt) s.watermark = result.lastCreatedAt
        store.addMany(result.strokes)
      }

      async function resync() {
        if (resyncing || disposed) return true
        resyncing = true
        try {
          await loadHistory()
          return true
        } catch (error) {
          console.warn('[doodlescrap] could not catch up with the canvas', error)
          return false
        } finally {
          resyncing = false
        }
      }

      function scheduleRetry() {
        clearTimeout(retryTimer)
        retryTimer = setTimeout(async () => {
          if (disposed) return
          if (!(await resync())) scheduleRetry()
        }, 10000)
      }

      async function initialJoin() {
        let loaded = false
        for (let attempt = 1; attempt <= 4 && !disposed; attempt++) {
          try {
            await loadHistory()
            loaded = true
            break
          } catch (error) {
            console.warn('[doodlescrap] could not load strokes', error)
            if (attempt < 4) await sleep(1500 * attempt)
          }
        }
        if (disposed) return
        joined = true
        buffering = false
        for (const [event, payload] of buffer.splice(0)) {
          try {
            dispatch(event, payload)
          } catch (error) {
            console.warn('[doodlescrap] dropped bad broadcast', event, error)
          }
        }
        onVisualChange()
        if (!loaded) scheduleRetry()
      }

      // -- subscribe ------------------------------------------------------------
      channel.subscribe(async (state, error) => {
        if (disposed) return
        if (state === 'SUBSCRIBED') {
          s.subscribed = true
          setStatus('connected')
          try {
            await channel.track(s.presence)
          } catch {
            // presence is best-effort
          }
          if (disposed) return
          if (!joined) await initialJoin()
          else await resync()
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
          s.subscribed = false
          setStatus('reconnecting')
          if (error) console.warn('[doodlescrap] realtime:', error.message ?? error)
        }
      })

      // -- batched sending ------------------------------------------------------
      const pointsTimer = setInterval(() => {
        if (!s.subscribed) {
          s.pending = []
          return
        }
        if (!s.live || s.pending.length === 0) return
        while (s.pending.length > 0) {
          const pts = s.pending.splice(0, MAX_LIVE_BATCH_NUMBERS)
          s.live.seq += 1
          sendBroadcast(s, 'stroke_points', { k: s.key, id: s.live.id, seq: s.live.seq, pts })
        }
      }, LIVE_FLUSH_MS)

      const cursorTimer = setInterval(() => {
        // While drawing, the stroke points already tell everyone where we are.
        if (!s.subscribed || s.live || !s.cursorDirty || !s.cursor) return
        s.cursorDirty = false
        sendBroadcast(s, 'cursor', {
          k: s.key,
          x: quantize(s.cursor.x),
          y: quantize(s.cursor.y),
        })
      }, CURSOR_FLUSH_MS)

      // -- coming back to the tab / network -------------------------------------
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          hiddenAt = Date.now()
          return
        }
        // Phones suspend background tabs, which drops realtime messages.
        if (joined && hiddenAt && Date.now() - hiddenAt > 5000) resync()
        hiddenAt = 0
        s.queue.retryNow()
      }
      const onOnline = () => {
        s.queue.retryNow()
        if (joined) resync()
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('online', onOnline)

      return () => {
        disposed = true
        clearInterval(pointsTimer)
        clearInterval(cursorTimer)
        clearTimeout(retryTimer)
        for (const timer of verifyTimers) clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('online', onOnline)
        s.subscribed = false
        s.channel = null
        supabase.removeChannel(channel)
      }
    }

    let teardown = null
    const bootTimer = setTimeout(() => {
      teardown = boot()
    }, 0)
    return () => {
      clearTimeout(bootTimer)
      if (teardown) teardown()
    }
  }, [store, cursors, onVisualChange, loadBase])

  return {
    api,
    status,
    online,
    saving,
    banned,
    nameRejected,
    clearNameNotice: () => setNameRejected(false),
  }
}
