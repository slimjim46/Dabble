// All room-server limits live here. The Worker and both Durable Objects
// import this file: nothing else may hard-code a limit.
//
// Values mirror src/lib/constants.js where the two touch the same wire data
// (PAPER_SIZE, name length, live batch size). When those change, change both
// and say so in the commit message.

// ---- Room codes -----------------------------------------------------------
// 5 chars, alphabet without look-alikes (no 0/O/1/I/L). 31^5 = ~28.6M codes.
export const ROOM_CODE_LEN = 5
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/
export const CREATE_CODE_ATTEMPTS = 10 // collision retries on POST /rooms

// ---- Rooms ----------------------------------------------------------------
export const MAX_PLAYERS = 12 // seats held or connected
export const SEAT_HOLD_MS = 120000
export const ROOM_GRACE_MS = 300000 // empty room: deleteAll after this
export const MAX_ROOM_LIFETIME_MS = 4 * 60 * 60 * 1000
// Per-IP sockets per room. Production default is 4 (friends on one home
// network, mobile carriers share IPs). Dev overrides via env for the load
// test; the production env must not define IP_ROOM_SOCKET_LIMIT.
export const IP_ROOM_SOCKET_LIMIT = 4
export const SAME_USER_REPLACE_CLOSE = 4009 // older socket closed on reconnect
export const KICK_CLOSE = 4003 // kicked, blocked for this room's lifetime
export const ROOM_FULL_STATUS = 429 // pre-upgrade: no seat available
export const KICKED_STATUS = 403 // pre-upgrade: blocked from rejoining

// ---- Rooms creation limits (Limiter DO, hourly windows) -------------------
export const MAX_ROOMS_PER_USER_PER_HOUR = 5
export const MAX_ROOMS_PER_IP_PER_HOUR = 30
// Dev/load-test override for the per-IP hourly creation budget (same pattern
// as the socket cap; production env must not define it). The per-user limit
// has no override: tests and the load test use many fresh users.
export function maxRoomsPerIpPerHour(env = {}) {
  const n = Number(env?.MAX_ROOMS_PER_IP_PER_HOUR)
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : MAX_ROOMS_PER_IP_PER_HOUR
}

// ---- Identity -------------------------------------------------------------
export const IDENTITY_CACHE_MS = 60000
export const IDENTITY_TIMEOUT_MS = 2000 // then fail open as "Guest"
export const FALLBACK_NAME = 'Guest'

// ---- Messages -------------------------------------------------------------
export const MAX_MSG_BYTES = 8 * 1024 // else close 1009
export const MAX_VIOLATIONS = 20 // then close 1008
export const WIRE_VERSION = 1

// Sustained per-type budgets, token bucket per connection. DO messages are
// billed on arrival, so a breach CLOSES the socket instead of dropping.
// Rate (tokens/sec) and bucket capacity (burst).
export const RATE_BUDGET = {
  cursor: { perSec: 5, burst: 10 },
  stroke_points: { perSec: 20, burst: 40 },
  other: { perSec: 5, burst: 10 },
}

// Close codes for policy violations.
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_BIG = 1009

// ---- Wire data (mirrors src/lib/wire.js + src/lib/strokeCodec.js) ---------
export const PAPER_SIZE = 2000
export const MAX_NAME_LENGTH = 24
export const MAX_LIVE_BATCH_NUMBERS = 400 // stroke_points batches (wire.js)
export const MAX_FINAL_POINT_NUMBERS = 8000 // strokeCodec MAX_POINT_NUMBERS
export const MIN_STROKE_WIDTH = 1
export const MAX_STROKE_WIDTH = 40
export const MAX_KEY_LENGTH = 64

// ---- Per-IP socket cap (pure helpers, unit-tested in Node) ----------------
// Effective cap: env override (dev load test) or the default above.
export function maxIpSockets(env = {}) {
  const n = Number(env?.IP_ROOM_SOCKET_LIMIT)
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : IP_ROOM_SOCKET_LIMIT
}

/** @param atts attachments of currently connected sockets. */
export function ipCapAllows(atts, ipHash, limit) {
  if (!ipHash) return true // no salt configured: cap cannot be enforced
  let used = 0
  for (const a of atts) if (a && a.ipHash === ipHash) used++
  return used < limit
}
