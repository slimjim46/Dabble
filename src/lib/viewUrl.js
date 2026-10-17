import { MAX_SCALE, MIN_SCALE, MIN_VISIBLE, PAPER_SIZE } from './constants.js'

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Parse the shared view from ?x=&y=&z=. URL params are untrusted, so every
 * value is parseFloat'd, checked with Number.isFinite and clamped: the zoom is
 * pinned to the same MIN/MAX_SCALE as wheel/gesture zoom, and x/y are clamped so
 * at least MIN_VISIBLE px of paper stays on screen. Returns null when there is
 * nothing usable, so the caller can fall back to centering.
 *
 * @param {string} search  window.location.search (leading "?" optional)
 * @param {{width:number,height:number}} viewport  current canvas size in CSS px
 */
export function parseViewParams(search, viewport) {
  let params
  try {
    params = new URLSearchParams(search ?? '')
  } catch {
    return null
  }

  const rawX = params.get('x')
  const rawY = params.get('y')
  if (rawX === null || rawY === null) return null

  const x = Number.parseFloat(rawX)
  const y = Number.parseFloat(rawY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null

  const rawZ = params.get('z')
  const parsedZ = rawZ === null ? 1 : Number.parseFloat(rawZ)
  const scale = Number.isFinite(parsedZ) ? clamp(parsedZ, MIN_SCALE, MAX_SCALE) : 1

  const width = Number.isFinite(viewport?.width) ? viewport.width : PAPER_SIZE
  const height = Number.isFinite(viewport?.height) ? viewport.height : PAPER_SIZE
  const minX = MIN_VISIBLE - PAPER_SIZE * scale
  const minY = MIN_VISIBLE - PAPER_SIZE * scale
  const maxX = width - MIN_VISIBLE
  const maxY = height - MIN_VISIBLE

  return {
    scale,
    x: maxX < minX ? minX : clamp(x, minX, maxX),
    y: maxY < minY ? minY : clamp(y, minY, maxY),
  }
}

/** Build the shareable URL for a view. Keeps origin/path, drops any old params. */
export function buildShareUrl(href, view) {
  let url
  try {
    url = new URL(href)
  } catch {
    return href
  }
  url.search = ''
  url.hash = ''
  url.searchParams.set('x', String(Math.round(view.x)))
  url.searchParams.set('y', String(Math.round(view.y)))
  url.searchParams.set('z', Number(view.scale).toFixed(3))
  return url.toString()
}
