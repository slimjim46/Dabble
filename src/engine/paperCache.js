import { PAPER_SIZE } from '../lib/constants.js'
import { drawStroke } from '../lib/stroke.js'

// Database strokes carry a created_at; strokes that arrived live don't yet and
// are newer than anything we loaded, so they sort last (sort is stable).
function byCreatedAt(a, b) {
  if (a.createdAt && b.createdAt) {
    if (a.createdAt < b.createdAt) return -1
    if (a.createdAt > b.createdAt) return 1
    return 0
  }
  if (a.createdAt) return -1
  if (b.createdAt) return 1
  return 0
}

/**
 * Committed strokes rendered once onto an offscreen canvas. Each frame then
 * only blits this image and draws the live strokes on top.
 *  - append(): cheap, used for a single new stroke
 *  - rebuild(): used after removals or bulk loads
 *  - setBase(): the server-baked snapshot PNG every stroke older than the
 *    snapshot cutoff is already drawn into; rebuild() paints it under the
 *    strokes we hold so the paper always shows base + vectors.
 */
export function createPaperCache() {
  const canvas = document.createElement('canvas')
  canvas.width = PAPER_SIZE
  canvas.height = PAPER_SIZE
  const ctx = canvas.getContext('2d')

  let base = null

  function clear() {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, PAPER_SIZE, PAPER_SIZE)
  }

  function paintBase() {
    if (base) ctx.drawImage(base, 0, 0)
  }
  clear()

  return {
    canvas,

    append(stroke) {
      drawStroke(ctx, stroke)
    },

    rebuild(strokes) {
      clear()
      paintBase()
      const ordered = Array.from(strokes).sort(byCreatedAt)
      for (const stroke of ordered) drawStroke(ctx, stroke)
    },

    // Paints the base immediately (so the canvas can appear before the newer
    // strokes have loaded); rebuild() will repaint it once they arrive.
    setBase(image) {
      base = image || null
      clear()
      paintBase()
    },
  }
}