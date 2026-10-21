// Testable rendering function for daily challenge winners.
// Used by scripts/render-daily-winners.mjs and tests/dailyRenderer.test.mjs.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { drawStroke } from '../../src/lib/stroke.js'

const IMG_SIZE = 1080
const FONT_PATH = new URL('../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url).pathname

/**
 * Render a winner's strokes + prompt onto a 1080x1080 canvas.
 * @param {Array} strokes - array of {color, width, points: [x,y,...]}
 * @param {string} prompt - the prompt text
 * @returns {Canvas} the rendered canvas
 * @throws {Error} if font registration fails
 */
export function renderWinner(strokes, prompt) {
  const fontKey = GlobalFonts.registerFromPath(FONT_PATH, 'DailyFont')
  if (!fontKey) {
    throw new Error('font registration failed: DejaVuSans-Bold.ttf could not be loaded')
  }

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE)

  ctx.save()
  const scale = IMG_SIZE / 2000
  ctx.scale(scale, scale)
  for (const s of strokes ?? []) {
    const points = []
    for (let i = 0; i < s.points.length; i += 2) {
      points.push({ x: s.points[i], y: s.points[i + 1] })
    }
    drawStroke(ctx, { color: s.color, width: s.width, points })
  }
  ctx.restore()

  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.font = 'bold 48px DailyFont'
  ctx.textAlign = 'center'
  ctx.fillText(prompt ?? '', IMG_SIZE / 2, 60)

  return canvas
}
