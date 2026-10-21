import { useCallback, useEffect, useRef, useState } from 'react'
import { createPaperCache } from '../engine/paperCache.js'
import {
  MAX_LIVE_POINTS,
  MIN_SCALE,
  PAPER_SIZE,
  POINT_MIN_DIST_SCREEN,
  SIMPLIFY_EPSILON_SCREEN,
  STROKE_SPLIT_COST,
} from '../lib/constants.js'
import { DEFAULT_COLOR, PALETTE } from '../lib/palette.js'
import { drawStroke, segmentCost, simplifyPoints } from '../lib/stroke.js'
import { newStrokeId } from '../lib/strokeCodec.js'
import { DAILY_INK_BUDGET } from './constants.js'

const BRUSHES = [
  { label: 'S', value: 3 },
  { label: 'M', value: 6 },
  { label: 'L', value: 14 },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * The daily canvas: the same engine as the plaza (stroke store -> cached paper
 * -> live stroke) with a fixed, no-pan/no-zoom view, reused from RoomPaper. It
 * is single-player, so there is no socket and no cursor overlay: strokes are
 * committed locally and the screen reads them for submit. Ink is a FIXED
 * budget (no refill) and drains as you draw; when `disabled` (paper full) it
 * refuses new strokes.
 */
export default function DailyPaper({ store, onCommit, disabled, redrawRef }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const paperRef = useRef(null)
  if (!paperRef.current) paperRef.current = createPaperCache()

  const [color, setColor] = useState(DEFAULT_COLOR)
  const [brushWidth, setBrushWidth] = useState(6)
  const [ink, setInk] = useState(DAILY_INK_BUDGET)
  const [inkFlashing, setInkFlashing] = useState(false)

  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const liveStrokeRef = useRef(null)
  const activeRef = useRef(new Set())
  const drawingRef = useRef(null)
  const rafRef = useRef(0)
  const drawRef = useRef(() => {})
  const inkRef = useRef(DAILY_INK_BUDGET)
  const splitCostRef = useRef(0)
  const colorRef = useRef(color)
  const widthRef = useRef(brushWidth)
  const disabledRef = useRef(disabled)
  const flashTimerRef = useRef(0)

  colorRef.current = color
  widthRef.current = brushWidth
  disabledRef.current = disabled

  // ---- rendering ------------------------------------------------------------
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
    })
  }, [])

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
    if (liveStrokeRef.current) drawStroke(ctx, liveStrokeRef.current)

    ctx.restore()
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
      liveStrokeRef.current = null
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      clearTimeout(flashTimerRef.current)
    },
    [],
  )

  // ---- store -> cached paper -------------------------------------------------
  useEffect(() => {
    return store.subscribe((type, payload) => {
      if (type === 'add') paperRef.current.append(payload)
      else if (type === 'remove' || type === 'bulk') paperRef.current.rebuild(store.values())
      scheduleDraw()
    })
  }, [store, scheduleDraw])

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
      onCommit()
    },
    [store, onCommit],
  )

  const startStroke = useCallback(
    (clientX, clientY) => {
      if (disabledRef.current) return null
      if (inkRef.current < 2) {
        triggerInkFlash()
        return null
      }
      const stroke = {
        id: newStrokeId(),
        color: colorRef.current,
        width: widthRef.current,
        points: [screenToWorld(clientX, clientY)],
      }
      liveStrokeRef.current = stroke
      splitCostRef.current = 0
      scheduleDraw()
      return stroke
    },
    [screenToWorld, scheduleDraw, triggerInkFlash],
  )

  const endStroke = useCallback(() => {
    const stroke = liveStrokeRef.current
    liveStrokeRef.current = null
    if (stroke) commitStroke(stroke)
  }, [commitStroke])

  const cancelStroke = useCallback(() => {
    liveStrokeRef.current = null
    scheduleDraw()
  }, [scheduleDraw])

  const extendStroke = useCallback(
    (clientX, clientY) => {
      const stroke = liveStrokeRef.current
      if (!stroke) return
      const point = screenToWorld(clientX, clientY)
      const last = stroke.points[stroke.points.length - 1]
      const segLen = Math.hypot(point.x - last.x, point.y - last.y)
      if (segLen * viewRef.current.scale < POINT_MIN_DIST_SCREEN) return

      stroke.points.push(point)
      const segCost = segmentCost(segLen, stroke.width)
      inkRef.current = Math.max(0, inkRef.current - segCost)
      setInk(inkRef.current)

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
    [screenToWorld, endStroke, startStroke, scheduleDraw, triggerInkFlash],
  )

  // ---- pointers ----------------------------------------------------------------
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
      if (!activeRef.current.has(e.pointerId)) return
      if (e.pointerId !== drawingRef.current) return
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
      const events = coalesced.length ? coalesced : [e]
      for (const evt of events) extendStroke(evt.clientX, evt.clientY)
    },
    [extendStroke],
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

  useEffect(() => {
    if (disabled) {
      drawingRef.current = null
      cancelStroke()
    }
  }, [disabled, cancelStroke])

  const inkPercent = Math.round((ink / DAILY_INK_BUDGET) * 100)

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
      {!disabled && (
        <div className="toolbar">
          <div className={`ink-meter ${inkFlashing ? 'ink-meter-flash' : ''}`} title={`Ink ${inkPercent}%`}>
            <div className="ink-fill" style={{ width: `${inkPercent}%` }} />
          </div>
          <div className="toolbar-row">
            <div className="swatches" role="radiogroup" aria-label="Color">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={`Color ${c}`}
                  className={`swatch ${color === c ? 'swatch-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <div className="brushes" role="radiogroup" aria-label="Brush size">
              {BRUSHES.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  role="radio"
                  aria-checked={brushWidth === b.value}
                  className={`brush ${brushWidth === b.value ? 'brush-active' : ''}`}
                  onClick={() => setBrushWidth(b.value)}
                >
                  <span className="brush-dot" style={{ width: b.value + 4, height: b.value + 4 }} />
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
