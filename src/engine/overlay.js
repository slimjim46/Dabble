function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** "DE" -> 🇩🇪 (regional indicator pair). Unknown codes return ''. */
function flagEmoji(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/**
 * Draws remote cursors in screen space (so arrows and labels stay the same
 * size at any zoom). Call with the canvas already in CSS-pixel coordinates.
 */
export function drawCursors(ctx, cursors, view, viewWidth, viewHeight) {
  if (cursors.length === 0) return

  ctx.save()
  ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'

  for (const c of cursors) {
    const sx = view.x + c.x * view.scale
    const sy = view.y + c.y * view.scale
    if (sx < -140 || sy < -40 || sx > viewWidth + 20 || sy > viewHeight + 20) continue

    ctx.save()
    ctx.globalAlpha = c.alpha
    ctx.translate(sx, sy)

    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 15)
    ctx.lineTo(3.8, 11.6)
    ctx.lineTo(6.6, 17.6)
    ctx.lineTo(9, 16.5)
    ctx.lineTo(6.3, 10.6)
    ctx.lineTo(11, 10.4)
    ctx.closePath()
    ctx.fillStyle = c.color
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fill()

    const flag = flagEmoji(c.country)
    const label = flag ? `${flag} ${c.name}` : c.name
    const textWidth = ctx.measureText(label).width
    roundedRect(ctx, 10, 18, textWidth + 24, 20, 10)
    ctx.fillStyle = 'rgba(24, 24, 27, 0.86)'
    ctx.fill()

    ctx.beginPath()
    ctx.arc(19, 28, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = c.color
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, 27, 28.5)

    ctx.restore()
  }

  ctx.restore()
}