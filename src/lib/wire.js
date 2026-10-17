import { MAX_NAME_LENGTH, PAPER_SIZE } from './constants.js'
import {
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  isValidFlatPoints,
  isValidHexColor,
  isValidStroke,
} from './strokeCodec.js'

// Broadcast messages come from other browsers and anyone can send anything,
// so every incoming payload is checked before it touches the canvas.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_LIVE_BATCH_NUMBERS = 400

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PAPER_SIZE

export function parseStrokeStart(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id) || !isKey(p.userId)) return null
  if (typeof p.userName !== 'string' || p.userName.length < 1 || p.userName.length > MAX_NAME_LENGTH) return null
  if (!isValidHexColor(p.color)) return null
  if (typeof p.width !== 'number' || p.width < MIN_STROKE_WIDTH || p.width > MAX_STROKE_WIDTH) return null
  if (!isValidFlatPoints(p.pts) || p.pts.length !== 2) return null
  return p
}

export function parseStrokePoints(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  if (!Number.isInteger(p.seq) || p.seq < 1) return null
  if (!isValidFlatPoints(p.pts) || p.pts.length > MAX_LIVE_BATCH_NUMBERS) return null
  return p
}

export function parseStrokeEnd(p) {
  if (!p || !isKey(p.k) || !isValidStroke(p.stroke)) return null
  return p
}

export function parseStrokeCancel(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  return p
}

export function parseStrokeRemove(p) {
  if (!p || !isUuid(p.id) || !isKey(p.userId)) return null
  return p
}

export function parseCursor(p) {
  if (!p || !isKey(p.k) || !isCoord(p.x) || !isCoord(p.y)) return null
  return p
}

export function sanitizePresence(meta) {
  const name = typeof meta?.name === 'string' ? meta.name.trim().slice(0, MAX_NAME_LENGTH) : ''
  return {
    name: name || 'Guest',
    color: isValidHexColor(meta?.color) ? meta.color : '#6b6b73',
  }
}