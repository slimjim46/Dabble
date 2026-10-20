import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodePoints, quantize } from '../lib/strokeCodec.js'
import { colorForKey } from '../lib/palette.js'
import {
  MAX_FINAL_POINT_NUMBERS,
  MAX_GUESS_LENGTH,
  MAX_LIVE_BATCH_NUMBERS,
  ROOM_CURSOR_FLUSH_MS,
  ROOM_POINT_FLUSH_MS,
  nextAfterClose,
} from './roomsConfig.js'
import { createRoomsAuth } from './roomsAuth.js'
import {
  cursorMessage,
  encode,
  guessMessage,
  kickMessage,
  newRoomKey,
  parseRoomMessage,
  pickMessage,
  probeRoom,
  startMessage,
  strokeCancelMessage,
  strokeEndMessage,
  strokePointsMessage,
  strokeStartMessage,
} from './roomsWire.js'

const STALE_LIVE_MS = 15000 // drop an unfinished stroke from someone who vanished
const OPEN = 1

function socketUrl(roomsUrl, code) {
  return `${roomsUrl.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(code)}`
}

function isOnline() {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' || navigator.onLine
}

/**
 * Everything network-related for one room: the pre-join probe, the socket,
 * bounded reconnects with a fresh Supabase session on every attempt, the send
 * budgets the server enforces, and pushing validated frames into the stroke and
 * cursor stores without touching React state.
 *
 * Returns a stable `api` for the drawing code (same shape the plaza's
 * useRealtimeCanvas exposes, minus persistence) plus the few values the room
 * chrome renders.
 */
export function useRoomTransport({ roomsUrl, code, store, cursors, onVisualChange }) {
  const [status, setStatus] = useState('idle') // idle|connecting|connected|reconnecting|error
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const [players, setPlayers] = useState([])
  const [seat, setSeat] = useState(null)
  const [isHost, setIsHost] = useState(false)
  const [kickNotice, setKickNotice] = useState(null)
  // The server owns the game. The client only renders the latest public state
  // frame and the two secret frames the drawer alone receives. `game.at` is a
  // local monotonic stamp so the header countdown never compares a server
  // timestamp with Date.now() — it counts down from remainingMs on every frame.
  const [game, setGame] = useState(null)
  const [wordPick, setWordPick] = useState(null)
  const [yourWord, setYourWord] = useState(null)
  const [reveal, setReveal] = useState(null)
  // Guessing (v2 Phase 3 step 4a): the private reply to our own guess and a
  // transient per-round cap notice. Neither is a connection error.
  const [guessAck, setGuessAck] = useState(null)
  const [guessNotice, setGuessNotice] = useState(null)

  const visualRef = useRef(onVisualChange)
  visualRef.current = onVisualChange
  const notify = useCallback(() => visualRef.current?.(), [])

  const conn = useRef(null)
  if (!conn.current) {
    conn.current = {
      key: newRoomKey(),
      socket: null,
      gen: 0, // which attempt owns the handlers currently registered
      deliberate: false,
      live: null, // { id, seq } of our own in-progress stroke
      pending: [], // flat [x, y, ...] waiting for the next flush
      cursor: null,
      cursorDirty: false,
      seenKeys: new Set(), // k values we already know the identity of
      keyToUser: new Map(),
      playersById: new Map(), // userId -> player entry from welcome/presence
      pendingAttempt: 1,
      retryTimer: 0,
      waitingForOnline: false,
      status: 'idle', // mirrors the React status for the visibility handler
      fatal: false, // a fatal close code was reached: never auto-reconnect
    }
  }

  // Keep the React status and the ref mirror in step so the visibility handler
  // can read the live status without a stale closure.
  const applyStatus = useCallback((next) => {
    conn.current.status = next
    setStatus(next)
  }, [])

  // ---- auth ----------------------------------------------------------------
  // Fresh session per attempt, one refresh per readable 401: see roomsAuth.js.
  const auth = useMemo(() => createRoomsAuth(), [])

  // ---- inbound -------------------------------------------------------------
  const applyMessage = useCallback(
    (frame) => {
      const s = conn.current
      switch (frame.type) {
        case 'welcome': {
          setReady(true)
          setSeat(frame.data.seat)
          setIsHost(frame.data.host)
          setPlayers(frame.data.players)
          s.playersById = new Map(frame.data.players.map((p) => [p.userId, p]))
          // A fresh connection has no game context: drop anything the previous
          // socket left behind (a stale secret must never survive a reconnect).
          setGame(null)
          setWordPick(null)
          setYourWord(null)
          setReveal(null)
          setGuessAck(null)
          setGuessNotice(null)
          break
        }

        case 'presence': {
          setPlayers(frame.data.players)
          const { event, userId } = frame.data
          s.playersById = new Map(frame.data.players.map((p) => [p.userId, p]))
          if (event === 'leave' || event === 'part') {
            const key = s.keyToUser.get(userId)
            if (key) {
              cursors.remove(key)
              store.endLive(key)
            }
          }
          break
        }

        case 'stroke_start': {
          const p = frame.data
          if (p.k === s.key || store.has(p.id)) return
          const points = decodePoints(p.pts)
          const started = store.startLive(p.k, {
            id: p.id,
            userId: p.userId,
            userName: p.userName,
            color: p.color,
            width: p.width,
            points,
          })
          if (!started) return
          s.keyToUser.set(p.k, p.userId)
          s.seenKeys.add(p.k)
          cursors.setInfo(p.k, p.userName, colorForKey(p.userId), s.playersById.get(p.userId)?.country ?? null)
          cursors.update(p.k, points[0].x, points[0].y)
          break
        }

        case 'stroke_points': {
          const p = frame.data
          if (p.k === s.key) return
          const live = store.getLive(p.k)
          if (!live || live.id !== p.id || p.seq <= live.seq) return
          // The server accepts at most MAX_FINAL_POINT_NUMBERS numbers in the
          // final stroke, so a live one may never grow past half that.
          if (live.points.length >= MAX_FINAL_POINT_NUMBERS / 2) return
          const points = decodePoints(p.pts)
          for (const point of points) live.points.push(point)
          live.seq = p.seq
          live.updatedAt = performance.now()
          const last = points[points.length - 1]
          cursors.update(p.k, last.x, last.y)
          break
        }

        case 'stroke_end': {
          const p = frame.data
          if (p.k === s.key) return
          store.endLive(p.k, p.stroke.id)
          s.keyToUser.set(p.k, p.stroke.userId)
          s.seenKeys.add(p.k)
          cursors.setInfo(
            p.k,
            p.stroke.userName,
            colorForKey(p.stroke.userId),
            s.playersById.get(p.stroke.userId)?.country ?? null,
          )
          store.add({
            id: p.stroke.id,
            userId: p.stroke.userId,
            userName: p.stroke.userName,
            color: p.stroke.color,
            width: p.stroke.width,
            points: decodePoints(p.stroke.points),
          })
          const last = p.stroke.points
          if (last.length >= 2) cursors.update(p.k, last[last.length - 2], last[last.length - 1])
          break
        }

        case 'stroke_cancel': {
          const p = frame.data
          if (p.k === s.key) return
          store.endLive(p.k, p.id)
          break
        }

        case 'cursor': {
          const p = frame.data
          if (p.k === s.key) return
          // The frame carries the sender's userId, so a cursor gets its name
          // and colour before the player has drawn anything. A player missing
          // from presence (released seat, late frame) still falls back to the
          // neutral chip: never invent a name for a wire key.
          if (!s.seenKeys.has(p.k)) {
            s.seenKeys.add(p.k)
            const player = p.userId ? s.playersById.get(p.userId) : null
            if (p.userId) s.keyToUser.set(p.k, p.userId)
            cursors.setInfo(
              p.k,
              player?.name ?? '',
              colorForKey(p.userId ?? p.k),
              player?.country ?? null,
            )
          }
          cursors.update(p.k, p.x, p.y)
          break
        }

        case 'snapshot': {
          // The authoritative content of the current round: diff it into the
          // store (usually zero changes) and drop anything the round no longer
          // has — a round clear arrives as an empty snapshot, same one rule.
          const p = frame.data
          const keep = new Set(p.strokes.map((s2) => s2.id))
          for (const s2 of [...store.values()]) {
            if (!keep.has(s2.id)) store.remove(s2.id)
          }
          store.addMany(
            p.strokes.map((s2) => ({
              id: s2.id,
              userId: s2.userId,
              userName: s2.userName,
              color: s2.color,
              width: s2.width,
              points: decodePoints(s2.points),
            })),
          )
          break
        }

        case 'kick_ack':
          setKickNotice({ ok: true, userId: frame.data.userId, at: Date.now() })
          break

        case 'kick_err':
          setKickNotice({ ok: false, reason: frame.data.reason, at: Date.now() })
          break

        // ---- game (v2 Phase 3 step 3) ----------------------------------
        // The public state frame is the clock: remainingMs + a local monotonic
        // stamp. `state` arrives on every phase change (and periodically while
        // drawing), so the header countdown resyncs on each one.
        case 'state':
          setGame({ ...frame.data, at: performance.now(), atWall: Date.now() })
          break

        // Drawer-only frames. A non-drawer never receives these; a stale one
        // from a previous round is ignored by the screen (round is checked).
        case 'word_pick':
          setWordPick(frame.data)
          break

        case 'your_word':
          setYourWord(frame.data)
          break

        case 'reveal':
          // The drawing phase is over: the drawer's in-flight line can never be
          // completed (the server ignores a late stroke_end once mayDraw flips),
          // so drop every live stroke now instead of leaving a ghost on the
          // paper until it prunes. Identical for an early finish and a timeout.
          store.clearLive()
          setReveal(frame.data)
          break

        // The private reply to one guess. Only the guesser ever receives it;
        // the text and the word are never in it.
        case 'guess_ack':
          setGuessAck({ ...frame.data, at: Date.now() })
          break

        case 'error':
          // A transient server notice. `guess_cap` must NOT become a fatal
          // `status: 'error'` screen (that would block reconnect-on-visible),
          // so it is kept as a notice beside `busy`.
          if (frame.data.reason === 'guess_cap') setGuessNotice({ reason: 'guess_cap', at: Date.now() })
          else setError(frame.data.reason)
          break

        default:
          return
      }
      notify()
    },
    [cursors, store, notify],
  )

  // ---- lifecycle -----------------------------------------------------------
  const run = useCallback(
    async (attempt) => {
      const s = conn.current
      const gen = ++s.gen
      s.waitingForOnline = false
      // Starting a fresh attempt means we are no longer on a fatal screen.
      s.fatal = false
      applyStatus(attempt === 1 ? 'connecting' : 'reconnecting')
      setReady(false)
      setError(null)

      if (!roomsUrl || !code) return
      if (!isOnline()) {
        // Nothing to retry against. Hold here until the 'online' event.
        s.pendingAttempt = attempt
        s.waitingForOnline = true
        return
      }

      // Never leave a previous attempt's socket alive alongside this one: its
      // handlers are already invalidated by the generation bump above.
      const previous = s.socket
      s.socket = null
      if (previous && previous.readyState <= 1) {
        try {
          previous.close(1000, 'replaced')
        } catch {}
      }

      const token = await auth.getToken()
      if (s.gen !== gen) return
      if (!token) {
        applyStatus('error')
        setError('auth')
        return
      }

      // Probe first: 404, 429 and 503 are invisible on a WebSocket handshake.
      const probe = await probeRoom({ roomsUrl, code, auth })
      if (s.gen !== gen) return
      if (!probe.ok) {
        applyStatus('error')
        setError(probe.error)
        return
      }
      if (probe.full) {
        applyStatus('error')
        setError('full')
        return
      }

      let opened = false
      let ws
      try {
        ws = new WebSocket(socketUrl(roomsUrl, code), ['dabble.v1', token])
      } catch {
        if (s.gen !== gen) return
        applyStatus('error')
        setError('join_failed')
        return
      }

      s.socket = ws
      s.deliberate = false

      ws.onopen = () => {
        if (s.gen !== gen) return
        opened = true
        applyStatus('connected')
        setError(null)
      }

      ws.onmessage = (event) => {
        if (s.gen !== gen) return
        const frame = parseRoomMessage(typeof event.data === 'string' ? event.data : '')
        if (!frame) return // a malformed or unknown frame is dropped, never thrown
        try {
          applyMessage(frame)
        } catch {
          // A frame that passes validation but breaks the store must not kill
          // the socket handler.
        }
      }

      ws.onclose = (event) => {
        if (s.gen !== gen) return
        s.socket = null
        setReady(false)
        if (s.live) {
          s.live = null
          s.pending = []
        }
        if (s.deliberate) {
          applyStatus('idle')
          setError(null)
          return
        }
        if (!isOnline()) {
          s.pendingAttempt = attempt
          s.waitingForOnline = true
          applyStatus('reconnecting')
          setError(null)
          return
        }
        const outcome = nextAfterClose({ opened, deliberate: false, code: event.code, attempt })
        // A fatal code (kicked, replaced, expired, policy, too big) is a final
        // screen: the visibility handler must never auto-retry it.
        s.fatal = outcome.status === 'error'
        applyStatus(outcome.status)
        setError(outcome.error)
        if (outcome.status === 'reconnecting') {
          clearTimeout(s.retryTimer)
          s.pendingAttempt = outcome.attempt
          s.retryTimer = setTimeout(() => run(outcome.attempt), outcome.delay)
        }
      }

      ws.onerror = () => {}
    },
    [roomsUrl, code, auth, applyMessage, applyStatus],
  )

  // ---- send ----------------------------------------------------------------
  const send = useCallback((message) => {
    const s = conn.current
    const ws = s.socket
    if (!ws || ws.readyState !== OPEN) return
    try {
      ws.send(encode(message))
    } catch {
      // The close handler runs regardless; nothing useful to do here.
    }
  }, [])

  const api = useMemo(() => {
    const s = conn.current
    return {
      strokeStart(stroke) {
        s.live = { id: stroke.id, seq: 0 }
        s.pending = []
        send(strokeStartMessage(s.key, stroke))
      },
      strokePoint(point) {
        if (!s.live) return
        s.pending.push(quantize(point.x), quantize(point.y))
      },
      strokeEnd(stroke) {
        if (s.live?.id === stroke.id) s.live = null
        s.pending = []
        send(strokeEndMessage(s.key, stroke))
      },
      strokeCancel(id) {
        if (s.live?.id === id) s.live = null
        s.pending = []
        send(strokeCancelMessage(s.key, id))
      },
      cursor(x, y) {
        s.cursor = { x, y }
        s.cursorDirty = true
      },
      kick(userId) {
        send(kickMessage(userId))
      },
      start() {
        send(startMessage())
      },
      pick(i) {
        send(pickMessage(i))
      },
      guess(text) {
        const t = typeof text === 'string' ? text.trim() : ''
        if (t.length === 0 || t.length > MAX_GUESS_LENGTH) return
        send(guessMessage(t))
      },
      leave() {
        s.deliberate = true
        s.waitingForOnline = false
        clearTimeout(s.retryTimer)
        const ws = s.socket
        if (ws && ws.readyState <= 1) {
          try {
            ws.close(1000, 'left')
          } catch {}
        }
        s.socket = null
        s.fatal = false
        applyStatus('idle')
        setReady(false)
        setError(null)
        setGame(null)
        setWordPick(null)
        setYourWord(null)
        setReveal(null)
        setGuessAck(null)
        setGuessNotice(null)
      },
      retry() {
        clearTimeout(s.retryTimer)
        run(1)
      },
    }
  }, [send, run, applyStatus])

  // ---- start / stop --------------------------------------------------------
  useEffect(() => {
    if (!roomsUrl || !code) return undefined
    const s = conn.current
    let cancelled = false
    const start = (attempt) => {
      if (!cancelled) run(attempt)
    }
    start(1)

    const onOnline = () => {
      if (cancelled || !s.waitingForOnline) return
      clearTimeout(s.retryTimer)
      start(Math.max(1, s.pendingAttempt))
    }
    window.addEventListener('online', onOnline)

    // Returning from a locked/backgrounded screen: if the socket is not up and
    // this is not a fatal screen, retry the existing reconnect path (fresh
    // session, shared backoff). A no-op when already connected or when a retry
    // is already scheduled.
    const onVisible = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (s.status === 'connected' || s.fatal) return
      if (s.retryTimer) return
      if (!isOnline()) {
        s.waitingForOnline = true
        return
      }
      start(Math.max(1, s.pendingAttempt))
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearTimeout(s.retryTimer)
      s.gen += 1 // invalidate every handler still registered
      s.deliberate = true
      const ws = s.socket
      s.socket = null
      s.live = null
      s.pending = []
      if (ws && ws.readyState <= 1) {
        try {
          ws.close(1000, 'left')
        } catch {}
      }
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [roomsUrl, code, run])

  // ---- batching ------------------------------------------------------------
  // Budgets the server enforces by closing the socket, so these intervals must
  // stay inside RATE_BUDGET (rooms/src/config.js). See roomsConfig.js.
  useEffect(() => {
    const s = conn.current
    const pointsTimer = setInterval(() => {
      const ws = s.socket
      if (!ws || ws.readyState !== OPEN) {
        s.pending = []
        return
      }
      if (!s.live || s.pending.length === 0) return
      while (s.pending.length > 0) {
        const pts = s.pending.splice(0, MAX_LIVE_BATCH_NUMBERS)
        s.live.seq += 1
        send(strokePointsMessage(s.key, s.live.id, s.live.seq, pts))
      }
    }, ROOM_POINT_FLUSH_MS)

    const cursorTimer = setInterval(() => {
      // While drawing, the stroke points already say where we are.
      const ws = s.socket
      if (!ws || ws.readyState !== OPEN || s.live || !s.cursorDirty || !s.cursor) return
      s.cursorDirty = false
      send(cursorMessage(s.key, s.cursor.x, s.cursor.y))
    }, ROOM_CURSOR_FLUSH_MS)

    return () => {
      clearInterval(pointsTimer)
      clearInterval(cursorTimer)
    }
  }, [send])

  // ---- housekeeping --------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      cursors.prune()
      const pruned = store.pruneStaleLive(performance.now(), STALE_LIVE_MS)
      if (pruned || cursors.size > 0) notify()
    }, 1000)
    return () => clearInterval(timer)
  }, [cursors, store, notify])

  return {
    api, status, ready, error, players, seat, isHost, kickNotice,
    game, wordPick, yourWord, reveal, guessAck, guessNotice,
  }
}
