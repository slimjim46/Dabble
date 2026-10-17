/**
 * Tap hit-testing for the report mode.
 *
 * A stroke is "hit" when the tap is within stroke.width / 2 plus 6 screen px
 * (converted to world units at the current scale) of its polyline. Among all
 * hits the nearest one wins; ties go to the newer stroke. Only called on tap,
 * never per pointer move.
 */

const HIT_PAD_PX = 6

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = 0
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq
    if (t < 0) t = 0
    else if (t > 1) t = 1
  }
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** Distance from a point to a stroke's polyline (Infinity when empty). */
export function distanceToStroke(stroke, px, py) {
  const pts = stroke?.points
  if (!pts || pts.length === 0) return Infinity
  if (pts.length === 1) return Math.hypot(px - pts[0].x, py - pts[0].y)
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const d = distanceToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y)
    if (d < best) best = d
  }
  return best
}

/**
 * @param strokes iterable of strokes in oldest -> newest order (as stored)
 * @param point   { x, y } in world/paper coordinates
 * @param scale   current view scale (screen px per world unit)
 * @returns the hit stroke, or null
 */
export function hitTest(strokes, point, scale) {
  const list = Array.isArray(strokes) ? strokes : Array.from(strokes)
  let best = null
  let bestDistance = Infinity
  for (let i = list.length - 1; i >= 0; i--) {
    const stroke = list[i]
    const tolerance = stroke.width / 2 + HIT_PAD_PX / scale
    const d = distanceToStroke(stroke, point.x, point.y)
    if (d <= tolerance && d < bestDistance) {
      best = stroke
      bestDistance = d
    }
  }
  return best
}
