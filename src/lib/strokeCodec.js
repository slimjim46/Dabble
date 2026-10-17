import { MAX_NAME_LENGTH, PAPER_SIZE } from './constants.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

export const MAX_POINT_NUMBERS = 8000
export const MIN_STROKE_WIDTH = 1
export const MAX_STROKE_WIDTH = 40

export function newStrokeId() {
  return crypto.randomUUID()
}

export function quantize(value) {
  return Math.round(value * 10) / 10
}

export function encodePoints(points) {
  const flat = new Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    flat[i * 2] = quantize(points[i].x)
    flat[i * 2 + 1] = quantize(points[i].y)
  }
  return flat
}

export function decodePoints(flat) {
  const points = new Array(flat.length / 2)
  for (let i = 0; i < points.length; i++) {
    points[i] = { x: flat[i * 2], y: flat[i * 2 + 1] }
  }
  return points
}

export function isValidFlatPoints(flat) {
  if (!Array.isArray(flat)) return false
  if (flat.length === 0 || flat.length > MAX_POINT_NUMBERS || flat.length % 2 !== 0) return false
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > PAPER_SIZE) return false
  }
  return true
}

export function isValidStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return false
  if (typeof stroke.id !== 'string' || !UUID_RE.test(stroke.id)) return false
  if (typeof stroke.userId !== 'string' || stroke.userId.length === 0 || stroke.userId.length > 64) return false
  if (typeof stroke.userName !== 'string' || stroke.userName.length === 0 || stroke.userName.length > MAX_NAME_LENGTH) return false
  if (typeof stroke.color !== 'string' || !HEX_COLOR_RE.test(stroke.color)) return false
  if (typeof stroke.width !== 'number' || stroke.width < MIN_STROKE_WIDTH || stroke.width > MAX_STROKE_WIDTH) return false
  if (!isValidFlatPoints(stroke.points)) return false
  return true
}

export function isValidHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

export function strokeToRow(stroke) {
  return {
    id: stroke.id,
    user_id: stroke.userId,
    user_name: stroke.userName,
    color: stroke.color,
    width: stroke.width,
    points: encodePoints(stroke.points),
    hidden: false,
  }
}

export function rowToStroke(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    color: row.color,
    width: row.width,
    points: decodePoints(row.points),
    createdAt: row.created_at,
  }
}

export function strokeToBroadcast(stroke) {
  return {
    id: stroke.id,
    userId: stroke.userId,
    userName: stroke.userName,
    color: stroke.color,
    width: stroke.width,
    points: encodePoints(stroke.points),
  }
}

export function broadcastToStroke(payload) {
  return {
    id: payload.id,
    userId: payload.userId,
    userName: payload.userName,
    color: payload.color,
    width: payload.width,
    points: decodePoints(payload.points),
  }
}
