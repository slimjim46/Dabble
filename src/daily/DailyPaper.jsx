import { useCallback, useEffect, useRef, useState } from 'react'
import { createPaperCache } from '../engine/paperCache.js'
import {
  MAX_LIVE_POINTS,
  MAX_SCALE,
  MIN_SCALE,
  MIN_VISIBLE,
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
 * -> live stroke) with the plaza's pan/zoom gestures. It is single-player, so
 * there is no socket and no cursor overlay: strokes are committed locally and
 * the screen reads them for submit. Ink is a FIXED budget (no refill) and
 * drains as you draw; when `disabled` (paper full) it refuses new strokes.
 */
export default function DailyPaper({ store, onCommit, disabled, redrawRef, recenterRef }) {
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
  const liveStrokeCostRef = useRef(0)
  const pointersRef = useRef(new Map())
  const gestureRef = useRef(null)
  const panKeyRef = useRef(false)
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
    const chrome = wrap.closest('.daily-screen')?.querySelector('.daily-top')
    const chromeBottom = chrome ? Math.max(0, chrome.getBoundingClientRect().bottom - rect.top) : 0
    const topPad = Math.max(pad, chromeBottom + 8)
    const usableHeight = rect.height - topPad - pad
    const scale = clamp(
      Math.min((rect.width - pad * 2) / PAPER_SIZE, usableHeight / PAPER_SIZE),
      MIN_SCALE,
      1,
    )
    const paperSize = PAPER_SIZE * scale
    viewRef.current = {
      scale,
      x: (rect.width - paperSize) / 2,
      y: topPad + Math.max(0, (usableHeight - paperSize) / 2),
    }
    scheduleDraw()
  }, [scheduleDraw])

  useEffect(() => {
    if (!recenterRef) return undefined
    recenterRef.current = centerView
    return () => {
      recenterRef.current = () => {}
    }
  }, [centerView, recenterRef])

  useEffect(() => {
    resizeCanvas()
    centerView()
    const wrap = wrapRef.current
    if (!wrap) return undefined
    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [resizeCanvas, centerView])

  useEffect(() => {
    const down = (event) => {
      if (event.code === 'Space' && event.target === document.body) {
        panKeyRef.current = true
        event.preventDefault()
      }
    }
    const up = (event) => {
      if (event.code === 'Space') panKeyRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

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
      liveStrokeCostRef.current = 0
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
    liveStrokeCostRef.current = 0
    if (stroke) commitStroke(stroke)
  }, [commitStroke])

  const cancelStroke = useCallback(() => {
    if (!liveStrokeRef.current) return
    liveStrokeRef.current = null
    inkRef.current = Math.min(DAILY_INK_BUDGET, inkRef.current + liveStrokeCostRef.current)
    liveStrokeCostRef.current = 0
    setInk(inkRef.current)
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
      const spent = Math.min(inkRef.current, segCost)
      liveStrokeCostRef.current += spent
      inkRef.current -= spent
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

  // ---- gestures ---------------------------------------------------------------
  const beginGesture = useCallback(() => {
    const points = [...pointersRef.current.values()]
    if (points.length < 2) return
    cancelStroke()
    const [a, b] = points
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
    const points = [...pointersRef.current.values()]
    if (points.length < 2) return
    const [a, b] = points
    const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1
    const midX = (a.clientX + b.clientX) / 2
    const midY = (a.clientY + b.clientY) / 2
    const scale = clamp(gesture.startView.scale * (distance / gesture.startDist), MIN_SCALE, MAX_SCALE)
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
    (event) => {
      canvasRef.current?.setPointerCapture(event.pointerId)
      pointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })

      if (pointersRef.current.size >= 2) {
        beginGesture()
        return
      }

      const isPan = event.button === 1 || (event.button === 0 && panKeyRef.current)
      if (isPan) {
        const wrap = wrapRef.current
        const rect = wrap ? wrap.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight }
        gestureRef.current = {
          panOnly: true,
          startMidX: event.clientX,
          startMidY: event.clientY,
          startView: { ...viewRef.current },
          containerRect: rect,
        }
        return
      }

      if (event.button !== 0 || disabledRef.current) return
      startStroke(event.clientX, event.clientY)
    },
    [beginGesture, startStroke],
  )

  const onPointerMove = useCallback(
    (event) => {
      if (!pointersRef.current.has(event.pointerId)) return
      pointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })

      const gesture = gestureRef.current
      if (gesture) {
        if (gesture.panOnly) {
          const scale = gesture.startView.scale
          const rect = gesture.containerRect
          const nextX = gesture.startView.x + (event.clientX - gesture.startMidX)
          const nextY = gesture.startView.y + (event.clientY - gesture.startMidY)
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

      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event]
      for (const point of coalesced.length ? coalesced : [event]) extendStroke(point.clientX, point.clientY)
    },
    [extendStroke, scheduleDraw, updateGesture],
  )

  const releasePointer = useCallback(
    (event) => {
      pointersRef.current.delete(event.pointerId)
      if (gestureRef.current) {
        if (pointersRef.current.size < 2) endGesture()
        return
      }
      if (liveStrokeRef.current) endStroke()
    },
    [endGesture, endStroke],
  )

  const cancelPointer = useCallback(
    (event) => {
      pointersRef.current.delete(event.pointerId)
      if (gestureRef.current) {
        if (pointersRef.current.size < 2) endGesture()
        return
      }
      cancelStroke()
    },
    [cancelStroke, endGesture],
  )

  const onWheel = useCallback((event) => {
    event.preventDefault()
    if (gestureRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const { x, y, scale } = viewRef.current
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    let dy = event.deltaY
    if (event.deltaMode === 1) dy *= 16
    else if (event.deltaMode === 2) dy *= 100
    const factor = Math.exp(-dy * (event.ctrlKey ? 0.01 : 0.0015))
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
  }, [scheduleDraw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onWheel])

  useEffect(() => {
    if (disabled) cancelStroke()
  }, [disabled, cancelStroke])

  const inkPercent = Math.round((ink / DAILY_INK_BUDGET) * 100)

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
