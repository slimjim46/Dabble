// The client's side of the daily-entry limits. It agrees exactly with
// public.submit_daily_entry (supabase/migrations/20261021170000_phase5a_daily.sql
// + 20261022000100_phase5b_daily_size_cap.sql) so a valid player never submits
// a batch the server would reject. Pure functions: tests/dailyClient.test.mjs
// runs these and the real RPC on the same edge payloads.
import { PAPER_SIZE } from '../lib/constants.js'
import { MAX_POINT_NUMBERS, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH } from '../lib/strokeCodec.js'
import {
  DAILY_INK_BUDGET,
  DAILY_INK_CAPACITY,
  DAILY_MAX_ENTRY_BYTES,
  DAILY_STROKE_CAP,
} from './constants.js'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function isHexColor(v) {
  return typeof v === 'string' && HEX_RE.test(v)
}

export function isValidWidth(w) {
  return typeof w === 'number' && Number.isFinite(w) && w >= MIN_STROKE_WIDTH && w <= MAX_STROKE_WIDTH
}

export function isValidFlatPoints(flat) {
  if (!Array.isArray(flat)) return false
  if (flat.length < 2 || flat.length > MAX_POINT_NUMBERS || flat.length % 2 !== 0) return false
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > PAPER_SIZE) return false
  }
  return true
}

/** Polyline length of a flat [x, y, ...] array, same as public.stroke_path_length. */
export function flatPathLength(flat) {
  let total = 0
  for (let i = 2; i < flat.length; i += 2) {
    total += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1])
  }
  return total
}

/** Ink cost of one stroke: path_length * width / 800 (the server's formula). */
export function strokeCost(flat, width) {
  return (flatPathLength(flat) * width) / 800
}

export function isValidStroke(s) {
  if (!s || typeof s !== 'object') return false
  if (!isHexColor(s.color)) return false
  if (!isValidWidth(s.width)) return false
  if (!isValidFlatPoints(s.points)) return false
  return strokeCost(s.points, s.width) <= DAILY_INK_CAPACITY
}

export function entryInk(strokes) {
  let total = 0
  for (const s of strokes) total += strokeCost(s.points, s.width)
  return total
}

// Postgres prints jsonb with object keys sorted and ", " / ": " separators,
// e.g. {"color": "#30a46c", "points": [1, 2], "width": 6}. This mirrors that
// so entryBytes() agrees with octet_length(p_strokes::text) on the server.
function jsonbText(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText(v[k])}`).join(', ')}}`
}

/** Byte length of the batch in the server's jsonb text form. */
export function entryBytes(strokes) {
  return new TextEncoder().encode(jsonbText(strokes)).length
}

/** The whole submission: {color, width, points (flat)} objects, in order. */
export function toSubmitShape(strokes) {
  return strokes.map((s) => ({ color: s.color, width: s.width, points: s.points }))
}

/**
 * Client-side validation that mirrors submit_daily_entry, in the same order:
 * array -> size -> stroke count -> per-stroke shape/ink -> total ink budget.
 */
export function validateEntry(strokes) {
  if (!Array.isArray(strokes)) return { ok: false, reason: 'not_array' }
  if (entryBytes(strokes) > DAILY_MAX_ENTRY_BYTES) return { ok: false, reason: 'too_large' }
  if (strokes.length > DAILY_STROKE_CAP) return { ok: false, reason: 'too_many_strokes' }
  for (const s of strokes) {
    if (!isValidStroke(s)) return { ok: false, reason: 'invalid_stroke' }
  }
  if (entryInk(strokes) > DAILY_INK_BUDGET) return { ok: false, reason: 'over_budget' }
  return { ok: true }
}
