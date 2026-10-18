// Wire format v1 for the rooms server. Ported from the app's
// src/lib/wire.js + src/lib/strokeCodec.js with the SAME validators:
// coordinate ranges, point counts, hex colors, name length.
//
// Every incoming message is hostile. Two-layer rules:
//  - shape validation lives here (parse* returns null on invalid input),
//  - identity fields (userId, userName, country) are NEVER trusted from the
//    payload: the Room DO overwrites them from the connection's trusted
//    attachment before anything is broadcast.
import {
  MAX_FINAL_POINT_NUMBERS,
  MAX_KEY_LENGTH,
  MAX_LIVE_BATCH_NUMBERS,
  MAX_NAME_LENGTH,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  PAPER_SIZE,
  WIRE_VERSION,
} from './config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LENGTH
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PAPER_SIZE
const isName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME_LENGTH
const isHex = (v) => typeof v === 'string' && HEX_COLOR_RE.test(v)

export function isValidFlatPoints(flat, maxNumbers = MAX_FINAL_POINT_NUMBERS) {
  if (!Array.isArray(flat)) return false
  if (flat.length === 0 || flat.length > maxNumbers || flat.length % 2 !== 0) return false
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > PAPER_SIZE) return false
  }
  return true
}

function isValidStrokeShape(stroke) {
  if (!stroke || typeof stroke !== 'object') return false
  if (!isUuid(stroke.id)) return false
  if (!isKey(stroke.userId) || !isName(stroke.userName)) return false
  if (!isHex(stroke.color)) return false
  if (typeof stroke.width !== 'number' || stroke.width < MIN_STROKE_WIDTH || stroke.width > MAX_STROKE_WIDTH) return false
  if (!isValidFlatPoints(stroke.points, MAX_FINAL_POINT_NUMBERS)) return false
  return true
}

/** @returns the envelope {v,t,p} or null. */
export function parseEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || msg.v !== WIRE_VERSION || typeof msg.t !== 'string') return null
  return { v: msg.v, t: msg.t, p: msg }
}

export function parseStrokeStart(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id) || !isKey(p.userId)) return null
  if (!isName(p.userName)) return null
  if (!isHex(p.color)) return null
  if (typeof p.width !== 'number' || p.width < MIN_STROKE_WIDTH || p.width > MAX_STROKE_WIDTH) return null
  if (!isValidFlatPoints(p.pts, MAX_LIVE_BATCH_NUMBERS) || p.pts.length !== 2) return null
  return p
}

export function parseStrokePoints(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  if (!Number.isInteger(p.seq) || p.seq < 1) return null
  if (!isValidFlatPoints(p.pts, MAX_LIVE_BATCH_NUMBERS)) return null
  return p
}

export function parseStrokeEnd(p) {
  if (!p || !isKey(p.k) || !isValidStrokeShape(p.stroke)) return null
  return p
}

export function parseStrokeCancel(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  return p
}

export function parseCursor(p) {
  if (!p || !isKey(p.k) || !isCoord(p.x) || !isCoord(p.y)) return null
  return p
}

export function parseKick(p) {
  if (!p || typeof p.userId !== 'string' || !isUuid(p.userId)) return null
  return p
}

// Every event type the DO accepts from clients, with its validator.
export const CLIENT_TYPES = Object.freeze({
  stroke_start: parseStrokeStart,
  stroke_points: parseStrokePoints,
  stroke_end: parseStrokeEnd,
  stroke_cancel: parseStrokeCancel,
  cursor: parseCursor,
  kick: parseKick,
})

// Types governed by a strict "one open stroke per connection" ownership rule.
export const STROKE_TYPES = Object.freeze(['stroke_start', 'stroke_points', 'stroke_end', 'stroke_cancel'])
