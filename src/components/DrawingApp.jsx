import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createCursorStore } from '../engine/cursorStore.js'
import { drawCursors } from '../engine/overlay.js'
import { createPaperCache } from '../engine/paperCache.js'
import { createStrokeStore } from '../engine/strokeStore.js'
import { useRealtimeCanvas } from '../hooks/useRealtimeCanvas.js'
import { useLiveStats } from '../hooks/useLiveStats.js'
import { useSession } from '../hooks/useSession.js'
import {
  INK_MAX,
  INK_REFILL_PER_SEC,
  MAX_LIVE_POINTS,
  MAX_REMOTE_CURSORS,
  MAX_SCALE,
  MIN_SCALE,
  MIN_VISIBLE,
  PAPER_SIZE,
  POINT_MIN_DIST_SCREEN,
  SIMPLIFY_EPSILON_SCREEN,
  STROKE_SPLIT_COST,
} from '../lib/constants.js'
import { loadIdentity, saveIdentity } from '../lib/identity.js'
import { hitTest } from '../engine/hitTest.js'
import { isReported, markReported, visibleToMe } from '../lib/reportedStrokes.js'
import { strokesNear } from '../lib/strokeApi.js'
import { isSupabaseEnabled, supabase } from '../lib/supabase.js'
import { drawStroke, segmentCost, simplifyPoints } from '../lib/stroke.js'
import { newStrokeId } from '../lib/strokeCodec.js'
import { buildShareUrl, parseViewParams } from '../lib/viewUrl.js'
import StatusPill from './StatusPill.jsx'
import Toolbar from './Toolbar.jsx'
import Leaderboard from './Leaderboard.jsx'

const STALE_LIVE_MS = 15000 // drop other people's unfinished strokes after this

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export default function DrawingApp() {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)

  const identity = useMemo(() => loadIdentity(), [])
  const store = useMemo(() => createStrokeStore(), [])
  const cursors = useMemo(() => createCursorStore(), [])
  const paperRef = useRef(null)
  if (!paperRef.current) paperRef.current = createPaperCache()

  const [color, setColor] = useState('#1d1d1f')
  const [brushWidth, setBrushWidth] = useState(6)
  const [ink, setInk] = useState(INK_MAX)
  const [canUndo, setCanUndo] = useState(false)
  const [name, setName] = useState(identity.name)
  const [nameDraft, setNameDraft] = useState(identity.name)
  const [editingName, setEditingName] = useState(false)
  const [inkFlashing, setInkFlashing] = useState(false)
  const [reportMode, setReportMode] = useState(false)
  const [reportTarget, setReportTarget] = useState(null) // { stroke, x, y, baked }
  const [renameErrorCode, setRenameErrorCode] = useState(null)
  const [reportThanks, setReportThanks] = useState(false)
  const [shareNotice, setShareNotice] = useState(false)

  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const liveStrokeRef = useRef(null)
  const pointersRef = useRef(new Map())
  const gestureRef = useRef(null)
  const panKeyRef = useRef(false)
  const rafRef = useRef(0)
  const drawRef = useRef(() => {})
  const inkRef = useRef(INK_MAX)
  const splitCostRef = useRef(0) // accrued cost of the current stroke
  const colorRef = useRef(color)
  const widthRef = useRef(brushWidth)
  const identityRef = useRef(identity)
  const cancelledRef = useRef(false)
  const flashTimerRef = useRef(0)
  const thanksTimerRef = useRef(0)
  const shareTimerRef = useRef(0)
  const reportTapRef = useRef(0)

  colorRef.current = color
  widthRef.current = brushWidth
  const reportModeRef = useRef(false)
  reportModeRef.current = reportMode

  // ---- rendering ------------------------------------------------------------
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
    })
  }, [])

  drawRef.current = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const view = viewRef.current
    const dpr = Number(canvas.dataset.dpr) || 1
    const cssW = canvas.width / dpr
    const cssH = canvas.height / dpr

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)

    // paper with a soft shadow
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.12)'
    ctx.shadowBlur = 24 * view.scale
    ctx.shadowOffsetY = 4 * view.scale
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, PAPER_SIZE, PAPER_SIZE)
    ctx.restore()

    // clip to the paper so nothing bleeds past the edge
    ctx.beginPath()
    ctx.rect(0, 0, PAPER_SIZE, PAPER_SIZE)
    ctx.clip()

    // everything committed (ours + everyone else's) is one cached bitmap
    ctx.drawImage(paperRef.current.canvas, 0, 0)

    // other people's strokes that are still being drawn
    for (const live of store.liveStrokes()) drawStroke(ctx, live)

    // our own in-progress stroke
    if (liveStrokeRef.current) drawStroke(ctx, liveStrokeRef.current)

    ctx.restore()

    // remote cursors in screen space (back on the dpr transform after restore)
    const now = performance.now()
    drawCursors(ctx, cursors.visible(now, MAX_REMOTE_CURSORS), view, cssW, cssH)
    if (cursors.isFading(now)) scheduleDraw() // keep animating the fade-out
  }

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const rect = wrap.getBoundingClientRect()
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    canvas.dataset.dpr = String(dpr)
    scheduleDraw()
  }, [scheduleDraw])

  const centerView = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const pad = 24
    const scale = clamp(
      Math.min((rect.width - pad * 2) / PAPER_SIZE, (rect.height - pad * 2) / PAPER_SIZE),
      MIN_SCALE,
      1,
    )
    viewRef.current = {
      scale,
      x: (rect.width - PAPER_SIZE * scale) / 2,
      y: (rect.height - PAPER_SIZE * scale) / 2,
    }
    scheduleDraw()
  }, [scheduleDraw])

  useEffect(() => {
    resizeCanvas()
    // A shared link (?x=&y=&z=) opens the canvas at that spot; anything missing
    // or malformed falls back to centering. parseViewParams clamps untrusted
    // values, so a hostile link cannot push the view off-screen.
    const wrap = wrapRef.current
    if (!wrap) return undefined
    const rect = wrap.getBoundingClientRect()
    const shared = parseViewParams(window.location.search, { width: rect.width, height: rect.height })
    if (shared) {
      viewRef.current = shared
      scheduleDraw()
    } else {
      centerView()
    }
    const observer = new ResizeObserver(() => resizeCanvas())
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [resizeCanvas, centerView, scheduleDraw])

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      clearTimeout(flashTimerRef.current)
      clearTimeout(thanksTimerRef.current)
      clearTimeout(shareTimerRef.current)
    },
    [],
  )

  // ---- sessions + live stats --------------------------------------------------
  const { country } = useSession()
  const liveStats = useLiveStats()

  // The baked snapshot is painted straight onto the paper cache so the canvas
  // shows up before the newer strokes have loaded.
  const loadBase = useCallback(
    (image) => {
      paperRef.current.setBase(image)
      scheduleDraw()
    },
    [scheduleDraw],
  )

  // ---- realtime ---------------------------------------------------------------
  const { api, status, online, saving, banned, nameRejected, clearNameNotice } =
    useRealtimeCanvas({
      identityRef,
      store,
      cursors,
      name,
      color,
      country,
      onVisualChange: scheduleDraw,
      loadBase,
    })

  // Keep the cached paper bitmap in step with the stroke store. Strokes this
  // visitor reported are filtered out of their own view (6.6.2).
  useEffect(() => {
    return store.subscribe((type, payload) => {
      if (type === 'add') {
        if (!isReported(payload.id)) paperRef.current.append(payload)
      } else if (type === 'remove' || type === 'bulk') {
        paperRef.current.rebuild(visibleToMe(store.values()))
      }
      setCanUndo(store.hasOwn(identityRef.current.id))
      scheduleDraw()
    })
  }, [store, scheduleDraw])

  // Housekeeping: expire idle cursors and ghost strokes from people who vanished.
  useEffect(() => {
    const timer = setInterval(() => {
      cursors.prune()
      const pruned = store.pruneStaleLive(performance.now(), STALE_LIVE_MS)
      if (pruned || cursors.size > 0) scheduleDraw()
    }, 1000)
    return () => clearInterval(timer)
  }, [cursors, store, scheduleDraw])

  // ---- ink --------------------------------------------------------------------
  // inkRef is the source of truth (drained per point, refilled on a timer).
  // React state is only synced here, so drawing never re-renders per point.
  useEffect(() => {
    let last = performance.now()
    let shown = inkRef.current
    const timer = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      if (inkRef.current < INK_MAX) {
        inkRef.current = Math.min(INK_MAX, inkRef.current + INK_REFILL_PER_SEC * dt)
      }
      const current = inkRef.current
      if (Math.abs(current - shown) >= 0.25 || (current === INK_MAX && shown !== INK_MAX)) {
        shown = current
        setInk(current)
      }
    }, 100)
    return () => clearInterval(timer)
  }, [])

  const triggerInkFlash = useCallback(() => {
    setInkFlashing(true)
    clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setInkFlashing(false), 300)
  }, [])

  // ---- keyboard pan -----------------------------------------------------------
  useEffect(() => {
    const down = (e) => {
      if (e.code === 'Space' && e.target === document.body) {
        panKeyRef.current = true
        e.preventDefault()
      }
    }
    const up = (e) => {
      if (e.code === 'Space') panKeyRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ---- drawing ----------------------------------------------------------------
  const screenToWorld = useCallback((clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const { x, y, scale } = viewRef.current
    return {
      x: clamp((clientX - rect.left - x) / scale, 0, PAPER_SIZE),
      y: clamp((clientY - rect.top - y) / scale, 0, PAPER_SIZE),
    }
  }, [])

  const commitStroke = useCallback(
    (stroke) => {
      const epsilon = SIMPLIFY_EPSILON_SCREEN / viewRef.current.scale
      const points =
        stroke.points.length > 2 ? simplifyPoints(stroke.points, epsilon) : stroke.points
      const committed = { ...stroke, points }
      store.add(committed) // the store listener paints it onto the paper cache
      api.strokeEnd(committed) // broadcast the final stroke + save in the background
    },
    [store, api],
  )

  const startStroke = useCallback(
    (clientX, clientY) => {
      if (banned) return null
      if (inkRef.current < 2) {
        triggerInkFlash()
        return null
      }
      const stroke = {
        id: newStrokeId(),
        userId: identityRef.current.id,
        userName: identityRef.current.name,
        color: colorRef.current,
        width: widthRef.current,
        points: [screenToWorld(clientX, clientY)],
      }
      liveStrokeRef.current = stroke
      splitCostRef.current = 0
      api.strokeStart(stroke)
      scheduleDraw()
      return stroke
    },
    [api, screenToWorld, scheduleDraw, triggerInkFlash, banned],
  )

  const endStroke = useCallback(() => {
    const stroke = liveStrokeRef.current
    liveStrokeRef.current = null
    if (stroke) commitStroke(stroke)
  }, [commitStroke])

  const cancelStroke = useCallback(() => {
    const stroke = liveStrokeRef.current
    if (!stroke) return
    liveStrokeRef.current = null
    api.strokeCancel(stroke.id)
    scheduleDraw()
  }, [api, scheduleDraw])

  const extendStroke = useCallback(
    (clientX, clientY) => {
      const stroke = liveStrokeRef.current
      if (!stroke) return
      const point = screenToWorld(clientX, clientY)
      const last = stroke.points[stroke.points.length - 1]
      const segLen = Math.hypot(point.x - last.x, point.y - last.y)
      if (segLen * viewRef.current.scale < POINT_MIN_DIST_SCREEN) return

      stroke.points.push(point)
      api.strokePoint(point)

      // Drain ink per segment (no setState here; the interval syncs the meter).
      const segCost = segmentCost(segLen, stroke.width)
      inkRef.current = Math.max(0, inkRef.current - segCost)

      if (inkRef.current <= 0) {
        endStroke()
        triggerInkFlash()
        return
      }

      // Very long scribble: close this stroke and carry on in a new one, so a
      // single stroke never exceeds what the wire format / database allows.
      // The cost split (STROKE_SPLIT_COST) also keeps every piece under the
      // server's ink capacity, so long strokes are never rejected with 22023.
      splitCostRef.current += segCost
      if (stroke.points.length >= MAX_LIVE_POINTS || splitCostRef.current >= STROKE_SPLIT_COST) {
        endStroke()
        startStroke(clientX, clientY)
        return
      }

      scheduleDraw()
    },
    [api, screenToWorld, endStroke, startStroke, scheduleDraw, triggerInkFlash],
  )

  // ---- gestures ---------------------------------------------------------------
  const beginGesture = useCallback(() => {
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return
    cancelStroke()
    const [a, b] = pts
    gestureRef.current = {
      startDist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
      startMidX: (a.clientX + b.clientX) / 2,
      startMidY: (a.clientY + b.clientY) / 2,
      startView: { ...viewRef.current },
    }
  }, [cancelStroke])

  const updateGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (!gesture) return
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return
    const [a, b] = pts
    const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1
    const midX = (a.clientX + b.clientX) / 2
    const midY = (a.clientY + b.clientY) / 2
    const scale = clamp(gesture.startView.scale * (dist / gesture.startDist), MIN_SCALE, MAX_SCALE)
    const factor = scale / gesture.startView.scale

    const wrap = wrapRef.current
    const rect = wrap ? wrap.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight }

    const nextX = midX - (gesture.startMidX - gesture.startView.x) * factor
    const nextY = midY - (gesture.startMidY - gesture.startView.y) * factor

    viewRef.current = {
      scale,
      x: clamp(nextX, MIN_VISIBLE - PAPER_SIZE * scale, rect.width - MIN_VISIBLE),
      y: clamp(nextY, MIN_VISIBLE - PAPER_SIZE * scale, rect.height - MIN_VISIBLE),
    }
    scheduleDraw()
  }, [scheduleDraw])

  const endGesture = useCallback(() => {
    gestureRef.current = null
  }, [])

  const onPointerDown = useCallback(
    (e) => {
      const canvas = canvasRef.current
      canvas.setPointerCapture(e.pointerId)
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })

      if (pointersRef.current.size >= 2) {
        beginGesture()
        return
      }

      const isPan = e.button === 1 || (e.button === 0 && panKeyRef.current)
      if (isPan) {
        const wrap = wrapRef.current
        const rect = wrap ? wrap.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight }
        gestureRef.current = {
          panOnly: true,
          startMidX: e.clientX,
          startMidY: e.clientY,
          startView: { ...viewRef.current },
          containerRect: rect,
        }
        return
      }

      if (e.button !== 0) return
      if (reportModeRef.current) {
        // Report mode: one tap hit-tests committed strokes (6.6.1); a miss asks
        // the server for baked strokes nearby (one RPC per tap). Nothing is
        // scanned per pointer move.
        const pad = 100
        const world = screenToWorld(e.clientX, e.clientY)
        const x = clamp(e.clientX, pad, window.innerWidth - pad)
        const y = clamp(e.clientY, pad + 44, window.innerHeight - pad)
        const hit = hitTest(visibleToMe(store.values()), world, viewRef.current.scale)
        if (hit) {
          setReportTarget({ stroke: hit, x, y })
          return
        }
        const tap = ++reportTapRef.current
        strokesNear(world.x, world.y)
          .then((near) => {
            if (tap !== reportTapRef.current) return
            // strokes_near is newest-first; hitTest expects oldest-first.
            const baked = hitTest(near.slice().reverse(), world, viewRef.current.scale)
            setReportTarget(baked ? { stroke: baked, x, y, baked: true } : null)
          })
          .catch(() => {
            if (tap === reportTapRef.current) setReportTarget(null)
          })
        return
      }
      startStroke(e.clientX, e.clientY)
    },
    [beginGesture, screenToWorld, startStroke, store],
  )

  const onPointerMove = useCallback(
    (e) => {
      if (!pointersRef.current.has(e.pointerId)) {
        // Hovering with a mouse: share where our cursor is. (Touch has no hover.)
        if (e.pointerType === 'mouse') {
          const p = screenToWorld(e.clientX, e.clientY)
          api.cursor(p.x, p.y)
        }
        return
      }
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })

      const gesture = gestureRef.current
      if (gesture) {
        if (gesture.panOnly) {
          const scale = gesture.startView.scale
          const rect = gesture.containerRect
          const nextX = gesture.startView.x + (e.clientX - gesture.startMidX)
          const nextY = gesture.startView.y + (e.clientY - gesture.startMidY)
          viewRef.current = {
            ...viewRef.current,
            x: clamp(nextX, MIN_VISIBLE - PAPER_SIZE * scale, rect.width - MIN_VISIBLE),
            y: clamp(nextY, MIN_VISIBLE - PAPER_SIZE * scale, rect.height - MIN_VISIBLE),
          }
          scheduleDraw()
        } else {
          updateGesture()
        }
        return
      }

      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
      for (const evt of coalesced.length ? coalesced : [e]) {
        extendStroke(evt.clientX, evt.clientY)
      }
    },
    [api, screenToWorld, extendStroke, updateGesture, scheduleDraw],
  )

  const releasePointer = useCallback(
    (e) => {
      pointersRef.current.delete(e.pointerId)

      if (gestureRef.current) {
        if (pointersRef.current.size < 2) endGesture()
        return
      }

      if (liveStrokeRef.current) endStroke()
    },
    [endGesture, endStroke],
  )

  const cancelPointer = useCallback(
    (e) => {
      pointersRef.current.delete(e.pointerId)
      if (gestureRef.current) {
        if (pointersRef.current.size < 2) endGesture()
        return
      }
      cancelStroke()
    },
    [endGesture, cancelStroke],
  )

  const onWheel = useCallback(
    (e) => {
      e.preventDefault()
      if (gestureRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      const { x, y, scale } = viewRef.current
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      else if (e.deltaMode === 2) dy *= 100

      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015))
      const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = nextScale / scale

      const nextX = cx - (cx - x) * ratio
      const nextY = cy - (cy - y) * ratio

      viewRef.current = {
        scale: nextScale,
        x: clamp(nextX, MIN_VISIBLE - PAPER_SIZE * nextScale, rect.width - MIN_VISIBLE),
        y: clamp(nextY, MIN_VISIBLE - PAPER_SIZE * nextScale, rect.height - MIN_VISIBLE),
      }
      scheduleDraw()
    },
    [scheduleDraw],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ---- undo / rename / report ------------------------------------------------
  const undo = useCallback(() => {
    const mine = store.lastOwn(identityRef.current.id)
    if (!mine) return
    store.remove(mine.id) // listener rebuilds the paper + refreshes canUndo
    api.removeStroke(mine.id) // hides it in the database and tells everyone
  }, [store, api])

  const handleReport = useCallback(
    (target) => {
      const stroke = target.stroke
      setReportTarget(null)
      // Hidden for this visitor right away, whether or not the server agrees yet.
      markReported(stroke.id)
      // PostgREST builders are lazy and expose only .then(), so wrap in a real
      // promise: .catch() on the builder itself would throw (and never send).
      Promise.resolve(supabase?.rpc('report_stroke', { p_stroke_id: stroke.id })).catch(() => {})
      if (target.baked) {
        // The stroke is painted into the snapshot PNG, so it cannot be erased
        // locally: the server hides it at 3 reports and the next full snapshot
        // drops it. Just confirm (Phase 5b).
        setReportThanks(true)
        clearTimeout(thanksTimerRef.current)
        thanksTimerRef.current = setTimeout(() => setReportThanks(false), 2000)
        return
      }
      paperRef.current.rebuild(visibleToMe(store.values()))
      scheduleDraw()
    },
    [store, scheduleDraw],
  )

  const shareView = useCallback(async () => {
    const url = buildShareUrl(window.location.href, viewRef.current)
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Dabble', url })
        return
      }
      await navigator.clipboard.writeText(url)
    } catch {
      // A cancelled share sheet or a blocked clipboard: nothing to show.
      return
    }
    setShareNotice(true)
    clearTimeout(shareTimerRef.current)
    shareTimerRef.current = setTimeout(() => setShareNotice(false), 2000)
  }, [])

  const commitRename = useCallback(async () => {    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    const current = identityRef.current
    const next = nameDraft.trim() || current.name
    if (next !== current.name && isSupabaseEnabled()) {
      // Server is the authority on names; on rejection keep the old one.
      const { data, error } = await supabase.auth.getSession()
      if (!error && data.session) {
        const { error: rpcError } = await supabase.rpc('set_my_name', { new_name: next })
        if (rpcError) {
          setRenameErrorCode(rpcError.code || '22023')
          setNameDraft(current.name)
          setEditingName(false)
          return
        }
      }
    }
    setRenameErrorCode(null)
    clearNameNotice()
    const updated = { ...current, name: next }
    saveIdentity(updated)
    identityRef.current = updated
    setName(next)
    setNameDraft(next)
    setEditingName(false)
  }, [nameDraft, clearNameNotice])

  return (
    <div ref={wrapRef} className="draw-wrap">
      <canvas
        ref={canvasRef}
        className="draw-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={cancelPointer}
      />

      <StatusPill status={status} online={online} saving={saving} countries={liveStats?.countries} />

      <Leaderboard country={country} />

      <button type="button" className="recenter-button" onClick={centerView} title="Recenter view">
        🎯
      </button>

      <button
        type="button"
        className="recenter-button share-button"
        onClick={shareView}
        title="Share this spot"
        aria-label="Share this spot"
      >
        <ShareIcon />
      </button>

      {(nameRejected || renameErrorCode) && !editingName && (
        <div className="name-notice">
          {renameErrorCode === 'PT429'
            ? 'Name changes are limited — try again later'
            : "That name isn't available"}
        </div>
      )}

      {banned && <div className="banned-notice">Drawing is paused for this session</div>}

      {reportThanks && <div className="report-thanks">Reported, thanks</div>}

      {shareNotice && <div className="share-notice">Link copied</div>}

      <div className="name-pill">
        {editingName ? (
          <input
            className="name-input"
            value={nameDraft}
            autoFocus
            maxLength={24}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                cancelledRef.current = true
                setNameDraft(identityRef.current.name)
                setEditingName(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="name-button"
            onClick={() => {
              cancelledRef.current = false
              setEditingName(true)
            }}
            title="Tap to rename"
          >
            {name}
          </button>
        )}
      </div>

      <Toolbar
        color={color}
        onColorChange={setColor}
        brushWidth={brushWidth}
        onBrushWidthChange={setBrushWidth}
        ink={ink}
        inkMax={INK_MAX}
        inkFlashing={inkFlashing}
        canUndo={canUndo}
        onUndo={undo}
        reportMode={reportMode}
        onToggleReport={() => {
          setReportMode((v) => {
            if (v) setReportTarget(null)
            return !v
          })
        }}
      />

      {reportTarget && (
        <div className="report-popover" style={{ left: reportTarget.x, top: reportTarget.y }}>
          <span className="report-author" title={reportTarget.stroke.userName}>
            {reportTarget.stroke.userName}
          </span>
          <button type="button" className="report-go" onClick={() => handleReport(reportTarget)}>
            Report
          </button>
          <button
            type="button"
            className="report-close"
            onClick={() => setReportTarget(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="15" cy="4" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="5" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="16" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7.1 8.9 12.9 5.1M7.1 11.1l5.8 3.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
