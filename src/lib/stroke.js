export function simplifyPoints(points, epsilon) {
  if (points.length < 3) return points.slice()

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  const stack = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()
    const a = points[start]
    const b = points[end]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy || 1

    let maxDist = 0
    let index = -1
    for (let i = start + 1; i < end; i++) {
      const p = points[i]
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
      const px = a.x + t * dx
      const py = a.y + t * dy
      const dist = Math.hypot(p.x - px, p.y - py)
      if (dist > maxDist) {
        maxDist = dist
        index = i
      }
    }

    if (maxDist > epsilon && index !== -1) {
      keep[index] = 1
      stack.push([start, index], [index, end])
    }
  }

  return points.filter((_, i) => keep[i] === 1)
}

export function pathLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

/**
 * Ink cost of one segment, and of a whole stroke. The formula must match the
 * server's (public.stroke_path_length(points) * width / 800.0) so the client
 * meter, the stroke split and the database agree.
 */
export function segmentCost(segLen, width) {
  return (segLen * width) / 800
}

export function strokeCost(points, width) {
  return segmentCost(pathLength(points), width)
}

export function strokePath(ctx, points) {
  if (points.length === 0) return

  ctx.beginPath()
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }

  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

export function drawStroke(ctx, stroke) {
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  strokePath(ctx, stroke.points)
}
