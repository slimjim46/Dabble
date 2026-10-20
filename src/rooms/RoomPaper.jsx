import { useCallback, useEffect, useRef, useState } from 'react'
import { createPaperCache } from '../engine/paperCache.js'
import { drawCursors } from '../engine/overlay.js'
import {
  INK_MAX,
  INK_REFILL_PER_SEC,
  MAX_LIVE_POINTS,
  MAX_REMOTE_CURSORS,
  MIN_SCALE,
  PAPER_SIZE,
  POINT_MIN_DIST_SCREEN,
  SIMPLIFY_EPSILON_SCREEN,
  STROKE_SPLIT_COST,
} from '../lib/constants.js'
import { DEFAULT_COLOR } from '../lib/palette.js'
import { drawStroke, segmentCost, simplifyPoints } from '../lib/stroke.js'
import { newRoomStrokeId } from './roomsWire.js'
import RoomToolbar from './RoomToolbar.jsx'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * The room canvas: the same engine as the plaza (stroke store -> cached paper
 * bitmap -> live strokes -> cursor overlay) with everything a room does not
 * have removed — no pinch or wheel zoom, no pan, no undo, no report, no
 * snapshot base. The view is always the whole sheet and re-fits itself on
 * every resize, which is what makes a phone rotation correct.
 *
 * Everything network-shaped arrives through `api`; this component only draws
 * and sends.
 */
export default function RoomPaper({ store, cursors, api, identity, disabled, redrawRef }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const paperRef = useRef(null)
  if (!paperRef.current) paperRef.current = createPaperCache()

  const [color, setColor] = useState(DEFAULT_COLOR)
  const [brushWidth, setBrushWidth] = useState(6)
  const [ink, setInk] = useState(INK_MAX)
  const [inkFlashing, setInkFlashing] = useState(false)

  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const liveStrokeRef = useRef(null)
  const activeRef = useRef(new Set())
  const drawingRef = useRef(null)
  const rafRef = useRef(0)
  const drawRef = useRef(() => {})
  const inkRef = useRef(INK_MAX)
  const splitCostRef = useRef(0)
  const colorRef = useRef(color)
  const widthRef = useRef(brushWidth)
  const identityRef = useRef(identity)
  const disabledRef = useRef(disabled)
  const flashTimerRef = useRef(0)

  colorRef.current = color
  widthRef.current = brushWidth
  identityRef.current = identity
  disabledRef.current = disabled

  // ---- rendering ------------------------------------------------------------
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
    })
  }, [])

  // Remote stroke points are pushed into the store in place (no event), so the
  // transport needs a way to ask for a frame. It hands us this ref rather than
  // taking a callback, because a callback would re-create it every render and
  // re-run the transport's start effect — a reconnect per render.
  useEffect(() => {
    if (!redrawRef) return undefined
    redrawRef.current = scheduleDraw
    return () => {
      redrawRef.current = () => {}
    }
  }, [scheduleDraw, redrawRef])

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

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.12)'
    ctx.shadowBlur = 24 * view.scale
    ctx.shadowOffsetY = 4 * view.scale
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, PAPER_SIZE, PAPER_SIZE)
    ctx.restore()

    ctx.beginPath()
    ctx.rect(0, 0, PAPER_SIZE, PAPER_SIZE)
    ctx.clip()

    ctx.drawImage(paperRef.current.canvas, 0, 0)

    for (const live of store.liveStrokes()) drawStroke(ctx, live)
    if (liveStrokeRef.current) drawStroke(ctx, liveStrokeRef.current)

    ctx.restore()

    const now = performance.now()
    drawCursors(ctx, cursors.visible(now, MAX_REMOTE_CURSORS), view, cssW, cssH)
    if (cursors.isFading(now)) scheduleDraw()
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

  // The whole sheet always fits: no pan or zoom exists to drift away, so a
  // rotation or a window resize only ever re-centres.
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
    centerView()
    const wrap = wrapRef.current
    if (!wrap) return undefined
    const observer = new ResizeObserver(() => {
      resizeCanvas()
      centerView()
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [resizeCanvas, centerView])

  useEffect(
    () => () => {
      const open = liveStrokeRef.current
      liveStrokeRef.current = null
      if (open) api.strokeCancel(open.id)
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      clearTimeout(flashTimerRef.current)
    },
    [api],
  )

  // ---- store -> cached paper -------------------------------------------------
  useEffect(() => {
    return store.subscribe((type, payload) => {
      if (type === 'add') paperRef.current.append(payload)
      else if (type === 'remove' || type === 'bulk') paperRef.current.rebuild(store.values())
      scheduleDraw()
    })
  }, [store, scheduleDraw])

  // ---- ink -------------------------------------------------------------------
  // inkRef is the source of truth (drained per point, refilled on a timer);
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
      const points = stroke.points.length > 2 ? simplifyPoints(stroke.points, epsilon) : stroke.points
      const committed = { ...stroke, points }
      store.add(committed)
      api.strokeEnd(committed)
    },
    [store, api],
  )

  const startStroke = useCallback(
    (clientX, clientY) => {
      if (disabledRef.current) return null
      if (inkRef.current < 2) {
        triggerInkFlash()
        return null
      }
      const stroke = {
        // crypto.randomUUID does not exist in an insecure context, and rooms
        // are exactly where people open an http:// link on a home network.
        id: newRoomStrokeId(),
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
    [api, screenToWorld, scheduleDraw, triggerInkFlash],
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

      const segCost = segmentCost(segLen, stroke.width)
      inkRef.current = Math.max(0, inkRef.current - segCost)

      if (inkRef.current <= 0) {
        endStroke()
        triggerInkFlash()
        return
      }

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

  // ---- pointers ----------------------------------------------------------------
  // One finger draws. A second is ignored rather than cancelled into a pinch:
  // rooms have no zoom, so an accidental palm should not eat the line.
  const onPointerDown = useCallback(
    (e) => {
      activeRef.current.add(e.pointerId)
      if (drawingRef.current !== null) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (disabledRef.current) return
      canvasRef.current?.setPointerCapture(e.pointerId)
      drawingRef.current = e.pointerId
      startStroke(e.clientX, e.clientY)
    },
    [startStroke],
  )

  const onPointerMove = useCallback(
    (e) => {
      if (!activeRef.current.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          // A read-only paper (drawing phase, non-drawer) must not spend the
          // cursor budget: without this a desktop watcher sends ~4 cursors/s
          // for the whole game. Lobby cursors stay (the lobby is not disabled).
          if (disabledRef.current) return
          const p = screenToWorld(e.clientX, e.clientY)
          api.cursor(p.x, p.y)
        }
        return
      }
      if (e.pointerId !== drawingRef.current) return
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
      const events = coalesced.length ? coalesced : [e]
      for (const evt of events) extendStroke(evt.clientX, evt.clientY)
    },
    [api, screenToWorld, extendStroke],
  )

  const onPointerUp = useCallback(
    (e) => {
      activeRef.current.delete(e.pointerId)
      if (e.pointerId !== drawingRef.current) return
      drawingRef.current = null
      endStroke()
    },
    [endStroke],
  )

  const onPointerCancel = useCallback(
    (e) => {
      activeRef.current.delete(e.pointerId)
      if (e.pointerId !== drawingRef.current) return
      drawingRef.current = null
      cancelStroke()
    },
    [cancelStroke],
  )

  // A stroke must not stay open across a disconnect: its points would be sent
  // into a socket that is already gone.
  useEffect(() => {
    if (disabled) {
      drawingRef.current = null
      cancelStroke()
    }
  }, [disabled, cancelStroke])

  return (
    <div ref={wrapRef} className="draw-wrap">
      <canvas
        ref={canvasRef}
        className="draw-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />

      {/* Read-only paper (a non-drawer during a round) hides the toolbar
          entirely rather than showing dead controls. Drawing is already
          refused by `disabledRef` in the pointer handlers; this only removes
          the affordance. While it is shown it is fully interactive. */}
      {!disabled && (
        <RoomToolbar
          color={color}
          onColorChange={setColor}
          brushWidth={brushWidth}
          onBrushWidthChange={setBrushWidth}
          ink={ink}
          inkMax={INK_MAX}
          inkFlashing={inkFlashing}
        />
      )}

    </div>
  )
}
