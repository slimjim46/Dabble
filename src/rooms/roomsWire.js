// The room client's side of the rooms wire format and its two HTTP entry
// points (POST /rooms, GET /rooms/<code>/status).
//
// This file deliberately mirrors rooms/src/wire.js rather than importing it:
// `rooms/` is a standalone Cloudflare project and `src/` must not depend on it
// to build. Two copies of one protocol is a real risk, so
// tests/roomClient.test.mjs runs every message this file can produce through
// the server's own CLIENT_TYPES parsers and asserts the shared constants match
// — the copies cannot drift without a red test.
//
// Everything arriving from the network is hostile. parseRoomMessage() returns
// null rather than throwing, and never lets an unvalidated field through.
import { MAX_NAME_LENGTH, PAPER_SIZE } from '../lib/constants.js'
import { BRUSH_IDS, PALETTE } from '../lib/palette.js'
import { encodePoints, quantize } from '../lib/strokeCodec.js'
import { MAX_FINAL_POINT_NUMBERS, MAX_LIVE_BATCH_NUMBERS, MAX_PLAYERS, ROOM_CODE_RE } from './roomsConfig.js'

export const WIRE_VERSION = 1
export const MAX_KEY_LENGTH = 64
export const MIN_STROKE_WIDTH = 1
export const MAX_STROKE_WIDTH = 40

// ---- identity on an insecure context ---------------------------------------
// crypto.randomUUID is only defined in secure contexts, and a room opened from
// http://<lan-ip>:5173 is a perfectly normal way to draw with someone next to
// you. Same fallback shape as src/lib/identity.js: randomUUID -> getRandomValues
// -> Math.random, so a stroke id is always a uuid (the wire requires one) and
// drawing never throws.
export function newRoomStrokeId(cryptoObj = globalThis.crypto) {
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoObj?.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = []
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'))
  const h = hex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// ---- validators (mirror of rooms/src/wire.js) -------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LENGTH
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PAPER_SIZE
const isName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_NAME_LENGTH

const PALETTE_SET = new Set(PALETTE)

function isPalette(v) {
  if (typeof v !== 'string') return null
  const c = v.toLowerCase()
  return PALETTE_SET.has(c) ? c : null
}

function isBrushId(v) {
  return typeof v === 'number' && Number.isInteger(v) && BRUSH_IDS.includes(v)
}
function brushOf(p) {
  const b = p?.b === undefined ? 0 : p.b
  return isBrushId(b) ? b : null
}

function isValidFlatPoints(flat, maxNumbers = MAX_FINAL_POINT_NUMBERS) {
  if (!Array.isArray(flat)) return false
  if (flat.length === 0 || flat.length > maxNumbers || flat.length % 2 !== 0) return false
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > PAPER_SIZE) return false
  }
  return true
}

function parsePlayer(raw) {
  if (!raw || typeof raw !== 'object' || !isKey(raw.userId)) return null
  const seat = raw.seat
  if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= MAX_PLAYERS) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : ''
  return {
    userId: raw.userId,
    seat,
    name: name || 'Guest',
    country: typeof raw.country === 'string' && /^[A-Z]{2}$/.test(raw.country) ? raw.country : null,
    host: raw.host === true,
  }
}

function parsePlayers(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const raw of list) {
    const player = parsePlayer(raw)
    if (player) out.push(player)
  }
  return out
}

function isValidStrokeShape(stroke) {
  if (!stroke || typeof stroke !== 'object') return false
  if (!isUuid(stroke.id)) return false
  if (!isKey(stroke.userId) || !isName(stroke.userName)) return false
  if (!isPalette(stroke.color)) return false
  if (typeof stroke.width !== 'number' || stroke.width < MIN_STROKE_WIDTH || stroke.width > MAX_STROKE_WIDTH) return false
  if (brushOf(stroke) === null) return false
  return isValidFlatPoints(stroke.points, MAX_FINAL_POINT_NUMBERS)
}

// ---- outbound ---------------------------------------------------------------
// Message builders only; the transport decides when to send them.

export function newRoomKey() {
  return newRoomStrokeId()
}

export function strokeStartMessage(k, stroke) {
  return {
    v: WIRE_VERSION,
    t: 'stroke_start',
    k,
    id: stroke.id,
    userId: stroke.userId,
    userName: stroke.userName,
    color: stroke.color,
    width: stroke.width,
    b: BRUSH_IDS[0],
    pts: encodePoints(stroke.points),
  }
}

export function strokePointsMessage(k, id, seq, flatPoints) {
  return { v: WIRE_VERSION, t: 'stroke_points', k, id, seq, pts: flatPoints }
}

export function strokeEndMessage(k, stroke) {
  return {
    v: WIRE_VERSION,
    t: 'stroke_end',
    k,
    stroke: {
      id: stroke.id,
      userId: stroke.userId,
      userName: stroke.userName,
      color: stroke.color,
      width: stroke.width,
      b: BRUSH_IDS[0],
      points: encodePoints(stroke.points),
    },
  }
}

export function strokeCancelMessage(k, id) {
  return { v: WIRE_VERSION, t: 'stroke_cancel', k, id }
}

export function cursorMessage(k, x, y) {
  return { v: WIRE_VERSION, t: 'cursor', k, x: quantize(x), y: quantize(y) }
}

export function kickMessage(userId) {
  return { v: WIRE_VERSION, t: 'kick', userId }
}

export function encode(message) {
  return JSON.stringify(message)
}

// ---- inbound ----------------------------------------------------------------
const PRESENCE_EVENTS = new Set(['join', 'leave', 'part', 'host'])
const KICK_REASONS = new Set(['self', 'not_found'])

function parseEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || msg.v !== WIRE_VERSION || typeof msg.t !== 'string') return null
  return msg
}

function parseWelcome(p) {
  if (typeof p.seat !== 'number' || !Number.isInteger(p.seat) || p.seat < 0 || p.seat >= MAX_PLAYERS) return null
  if (typeof p.host !== 'boolean') return null
  const players = parsePlayers(p.players)
  if (!players) return null
  return { seat: p.seat, host: p.host, players }
}

function parsePresence(p) {
  if (!PRESENCE_EVENTS.has(p.event)) return null
  if (!isKey(p.userId)) return null
  const players = parsePlayers(p.players)
  if (!players) return null
  const seat = p.seat
  if (seat !== null && (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= MAX_PLAYERS)) return null
  return { event: p.event, userId: p.userId, seat, players }
}

function parseStrokeStart(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id) || !isKey(p.userId)) return null
  if (!isName(p.userName)) return null
  const color = isPalette(p.color)
  if (!color) return null
  if (typeof p.width !== 'number' || p.width < MIN_STROKE_WIDTH || p.width > MAX_STROKE_WIDTH) return null
  if (!isValidFlatPoints(p.pts, MAX_LIVE_BATCH_NUMBERS) || p.pts.length !== 2) return null
  const b = brushOf(p)
  if (b === null) return null
  return { ...p, color, b }
}

function parseStrokePoints(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  if (!Number.isInteger(p.seq) || p.seq < 1) return null
  if (!isValidFlatPoints(p.pts, MAX_LIVE_BATCH_NUMBERS)) return null
  return p
}

function parseStrokeEnd(p) {
  if (!p || !isKey(p.k) || !isValidStrokeShape(p.stroke)) return null
  const s = p.stroke
  return { ...p, stroke: { ...s, color: isPalette(s.color), b: brushOf(s) } }
}

function parseStrokeCancel(p) {
  if (!p || !isKey(p.k) || !isUuid(p.id)) return null
  return p
}

function parseCursor(p) {
  if (!p || !isKey(p.k) || !isCoord(p.x) || !isCoord(p.y)) return null
  return p
}

function parseKickAck(p) {
  if (!p || !isUuid(p.userId)) return null
  return { userId: p.userId }
}

function parseKickErr(p) {
  if (!p || !KICK_REASONS.has(p.reason)) return null
  return { reason: p.reason }
}

const SERVER_TYPES = Object.freeze({
  welcome: parseWelcome,
  presence: parsePresence,
  stroke_start: parseStrokeStart,
  stroke_points: parseStrokePoints,
  stroke_end: parseStrokeEnd,
  stroke_cancel: parseStrokeCancel,
  cursor: parseCursor,
  kick_ack: parseKickAck,
  kick_err: parseKickErr,
})

/**
 * One frame from the room server -> { type, data }, or null if the frame is
 * not something this client understands or would accept. Unknown types are
 * dropped rather than treated as errors: the server may grow a message before
 * this client knows about it.
 */
export function parseRoomMessage(text) {
  const msg = parseEnvelope(text)
  if (!msg) return null
  const parse = SERVER_TYPES[msg.t]
  if (!parse) return null
  const data = parse(msg)
  return data ? { type: msg.t, data } : null
}

export { SERVER_TYPES }

// ---- HTTP -------------------------------------------------------------------
// Both entry points read a fresh Supabase token per attempt and retry a
// readable 401 exactly once with a refreshed session. A WebSocket handshake
// failure is never readable from a browser, which is the entire reason the
// pre-join probe exists.

function errorKind(status, body) {
  if (status === 400) return 'bad_code'
  if (status === 401) return 'auth'
  if (status === 403) {
    if (body?.error === 'kicked') return 'kicked'
    if (body?.error === 'origin') return 'origin'
    if (body?.error === 'captcha') return 'auth'
    return 'banned'
  }
  if (status === 404) return 'not_found'
  if (status === 429) return body?.error === 'too_many_connections' ? 'too_many' : 'rate_limited'
  if (status === 503) return 'busy'
  return 'unreachable'
}

async function authedJson(roomsUrl, path, { method = 'GET', body, auth, fetchImpl }) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'

  let token = await auth.getToken()
  if (!token) return { ok: false, status: 0, error: 'auth' }

  let response
  try {
    response = await fetchImpl(`${roomsUrl}${path}`, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 401) {
      // Exactly one refresh, then one retry: a looping refresh on a revoked
      // session would spin forever.
      token = await auth.refresh()
      if (!token) return { ok: false, status: 401, error: 'auth' }
      response = await fetchImpl(`${roomsUrl}${path}`, {
        method,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
  } catch {
    return { ok: false, status: 0, error: 'unreachable' }
  }

  const parsed = await response.json().catch(() => null)
  if (!response.ok) return { ok: false, status: response.status, error: errorKind(response.status, parsed) }
  return { ok: true, status: response.status, body: parsed }
}

/** POST /rooms -> { ok, code } */
export async function createRoom({ roomsUrl, auth, turn, fetchImpl = globalThis.fetch }) {
  const result = await authedJson(roomsUrl, '/rooms', {
    method: 'POST',
    body: turn ? { turn } : {},
    auth,
    fetchImpl,
  })
  if (!result.ok) return result
  const code = typeof result.body?.code === 'string' ? result.body.code.toUpperCase() : ''
  if (!ROOM_CODE_RE.test(code)) return { ok: false, status: result.status, error: 'unreachable' }
  return { ok: true, code }
}

/**
 * GET /rooms/<code>/status -> { ok, players, full }.
 * Runs before the socket is opened so 404/429/503/Retry-After are readable;
 * the upgrade still re-checks everything, so a room that fills between the
 * probe and the join fails generically and the caller shows a retry.
 */
export async function probeRoom({ roomsUrl, code, auth, fetchImpl = globalThis.fetch }) {
  if (!ROOM_CODE_RE.test(code)) return { ok: false, status: 400, error: 'bad_code' }
  const result = await authedJson(roomsUrl, `/rooms/${code}/status`, { auth, fetchImpl })
  if (!result.ok) return result
  return {
    ok: true,
    players: typeof result.body?.players === 'number' ? result.body.players : 0,
    full: result.body?.full === true,
  }
}
