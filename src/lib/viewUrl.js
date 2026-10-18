import { MAX_SCALE, MIN_SCALE, MIN_VISIBLE, PAPER_SIZE } from './constants.js'

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/** Viewport size, tolerating a missing or non-finite argument. */
function viewportSize(viewport) {
  return {
    width: Number.isFinite(viewport?.width) ? viewport.width : PAPER_SIZE,
    height: Number.isFinite(viewport?.height) ? viewport.height : PAPER_SIZE,
  }
}

/** Round to 0.1 canvas units: precise enough at MAX_SCALE, short in a URL. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Parse the shared view from ?cx=&cy=&z=. cx/cy name the canvas point that sat
 * in the middle of the sharer's screen, so every visitor re-centres it on their
 * own window: the canvas is what is shared, not someone's screen offsets.
 *
 * URL params are untrusted, so every value is parseFloat'd, checked with
 * Number.isFinite and clamped: the zoom is pinned to the same MIN/MAX_SCALE as
 * wheel/gesture zoom, and the resulting offsets are clamped so at least
 * MIN_VISIBLE px of paper stays on screen. Returns null when there is nothing
 * usable, so the caller can fall back to centering.
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

  const rawCx = params.get('cx')
  const rawCy = params.get('cy')
  if (rawCx === null || rawCy === null) return null

  const cx = Number.parseFloat(rawCx)
  const cy = Number.parseFloat(rawCy)
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null

  const rawZ = params.get('z')
  const parsedZ = rawZ === null ? 1 : Number.parseFloat(rawZ)
  const scale = Number.isFinite(parsedZ) ? clamp(parsedZ, MIN_SCALE, MAX_SCALE) : 1

  const { width, height } = viewportSize(viewport)
  // The centre lands at the middle of this visitor's screen; a hostile cx/cy
  // can only push that off-screen as far as the clamps below allow.
  const x = width / 2 - cx * scale
  const y = height / 2 - cy * scale
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

/**
 * Build the shareable URL for a view: the canvas point at the middle of the
 * view (?cx=&cy=) plus the zoom (?z=). Keeps origin/path, drops any old params.
 * Needs the current viewport to work out which canvas point that is; without a
 * usable view or viewport there is no link to hand out, so the href is returned
 * untouched rather than a link that points somewhere else.
 *
 * @param {string} href    window.location.href
 * @param {{x:number,y:number,scale:number}} view
 * @param {{width:number,height:number}} viewport
 */
export function buildShareUrl(href, view, viewport) {
  let url
  try {
    url = new URL(href)
  } catch {
    return href
  }

  const x = Number(view?.x)
  const y = Number(view?.y)
  const scale = Number(view?.scale)
  const width = Number(viewport?.width)
  const height = Number(viewport?.height)
  if (![x, y, scale, width, height].every(Number.isFinite)) return href
  if (!(scale > 0) || width <= 0 || height <= 0) return href

  url.search = ''
  url.hash = ''
  url.searchParams.set('cx', String(round1((width / 2 - x) / scale)))
  url.searchParams.set('cy', String(round1((height / 2 - y) / scale)))
  url.searchParams.set('z', scale.toFixed(3))
  return url.toString()
}
