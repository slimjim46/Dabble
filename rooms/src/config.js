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

// The only colours a stroke may use, in the order the plaza shows them.
// MUST equal COLORS in src/components/Toolbar.jsx: rooms/tests/wire-unit.test.mjs
// fails if the two lists drift apart. Matching it server-side (instead of any
// hex string) also lets us ship unlockable palettes later (v2 Phase 8)
// without another wire change.
export const PALETTE = Object.freeze([
  '#1d1d1f',
  '#e5484d',
  '#f76b15',
  '#f5a623',
  '#30a46c',
  '#0090ff',
  '#8e4ec6',
  '#e93d82',
])

// Brush ids on the wire. Everyone uses 0 for now; the list is the thing the
// client and the server agree on before the room client hardcodes the format.
export const BRUSH_IDS = Object.freeze([0])

// ---- Round stroke storage (v2 Phase 3) -------------------------------------
// One completed stroke per storage key under ROUND_KEY_PREFIX, written once
// on stroke_end and cleared at every round start. The caps bound the snapshot
// frame: MAX_MSG_BYTES is an INCOMING cap, so an unbounded round would become
// one giant outgoing frame. A stroke that would break any cap is simply not
// stored (the live relay is untouched) and the round is marked partial, so the
// client knows the snapshot is incomplete. Mirrors roomsConfig.js; asserted
// equal in tests/roomClient.test.mjs.
export const ROUND_KEY_PREFIX = 'rs:'
export const ROUND_SEQ_PAD = 6 // zero-padded so list() returns paint order
export const MAX_ROUND_STROKES = 500 // ~10x a 60 s round's strokes
export const MAX_ROUND_POINTS = 20000 // x/y pairs (~256 KB at ~12 B per point)
export const MAX_ROUND_BYTES = 256 * 1024 // one snapshot stays a sane frame

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

// ---- Game state machine (v2 Phase 3 step 2) --------------------------------
// Server-only for now: the client parses these frames but shows no game UI
// until step 4. All timings live here; dev shortens them via env (the same
// pattern as SEAT_HOLD_MS / ROOM_GRACE_MS) so live tests do not take an hour.
// Production must not define GAME_* or DRAWER_GRACE_MS.
export const PHASES = Object.freeze(['lobby', 'pick', 'drawing', 'reveal', 'scores', 'game_over'])
export const MIN_PLAYERS = 2 // seats held or connected; below this a game aborts
export const WORD_OPTIONS = 3 // choices shown to the drawer
export const MAX_WORD_LENGTH = 40
export const HINT_FRACTIONS = Object.freeze([0.5, 0.75]) // reveal letters, never the whole word
export const TARGET_ROUNDS = 6 // rounds per game, split evenly over the players
export const STORAGE_NOTICE_COOLDOWN_MS = 5000 // one busy error per cooldown

// Defaults: 6 rounds x 60 s drawing is ~10 minutes per game.
export const GAME_TIMING = Object.freeze({
  pick: 10000,
  drawing: 60000,
  reveal: 8000,
  scores: 8000,
  gameOver: 30000,
  drawerGrace: 10000,
})

const TIMING_ENV = Object.freeze({
  pick: 'GAME_PICK_MS',
  drawing: 'GAME_ROUND_MS',
  reveal: 'GAME_REVEAL_MS',
  scores: 'GAME_SCORES_MS',
  gameOver: 'GAME_OVER_MS',
  drawerGrace: 'DRAWER_GRACE_MS',
})

/**
 * Effective phase timings. Dev-only env overrides (tests); production has no
 * GAME_* vars and always gets GAME_TIMING. Values are clamped so a typo cannot
 * freeze a game or create a zero-length phase.
 */
export function gameTimings(env = {}) {
  const out = { ...GAME_TIMING }
  if (env?.ENVIRONMENT !== 'dev') return out
  for (const [key, name] of Object.entries(TIMING_ENV)) {
    const n = Number(env[name])
    if (Number.isFinite(n) && n >= 500 && n <= 60 * 60 * 1000) out[key] = Math.round(n)
  }
  return out
}
