// Pure configuration for the room client. Nothing here reads the DOM, the
// network or import.meta, so tests/roomClient.test.mjs can import it in plain
// Node. Server-side counterparts live in rooms/src/config.js; where the two
// describe the same rule they are asserted equal by that test.

// 5 chars, alphabet without look-alikes (no 0/O/1/I/L). Must equal
// ROOM_CODE_RE in rooms/src/config.js.
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/

// Seats held or connected. Must equal MAX_PLAYERS in rooms/src/config.js.
export const MAX_PLAYERS = 12

// ---- send budgets ----------------------------------------------------------
// Rooms close the socket on a sustained rate breach instead of dropping the
// message (the Durable Object is billed per message, so dropping saves
// nothing). These intervals are the client's side of RATE_BUDGET:
//
//   stroke_points  20/s, burst 40  ->  flush at most every 50 ms
//   cursor          5/s, burst 10  ->  flush at most every 200 ms
//
// 80 ms is 12.5 strokes-points/s and 250 ms is 4 cursors/s, so both sit under
// the budget with headroom for timer drift. tests/roomClient.test.mjs asserts
// the arithmetic against rooms/src/config.js rather than trusting this comment.
export const ROOM_POINT_FLUSH_MS = 80
export const ROOM_CURSOR_FLUSH_MS = 250

// Mirrors MAX_LIVE_BATCH_NUMBERS in rooms/src/wire.js (and src/lib/wire.js).
export const MAX_LIVE_BATCH_NUMBERS = 400

// Mirrors MAX_FINAL_POINT_NUMBERS in rooms/src/config.js / strokeCodec.
export const MAX_FINAL_POINT_NUMBERS = 8000

// ---- reconnect -------------------------------------------------------------
// A dropped socket is retried with capped exponential backoff; every attempt
// takes a fresh Supabase session first, because the token may have expired
// while the network was down.
export const RECONNECT_DELAYS_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 10000])
export const RECONNECT_JITTER = 0.25 // +/- 25% of the computed delay
export const MAX_RECONNECT_ATTEMPTS = 6

// Close codes that mean "the server decided this is over": never retry.
//   4003 kicked   4009 replaced by a newer socket   1001 room expired
//   1008 policy violation (rate limit, bad payload, room gone)
//   1009 message too big
export const FATAL_CLOSE_CODES = Object.freeze([4003, 4009, 1001, 1008, 1009])

export function isFatalClose(code) {
  return FATAL_CLOSE_CODES.includes(code)
}

/**
 * Backoff for reconnect number `attempt` (1-based), with +/- 25% jitter so a
 * room of clients that all dropped together does not return in lockstep.
 * `random` is injectable for the tests.
 */
export function reconnectDelay(attempt, random = Math.random) {
  const index = Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1
  const base = RECONNECT_DELAYS_MS[index]
  const spread = base * RECONNECT_JITTER
  return Math.max(0, Math.round(base - spread + random() * spread * 2))
}

/**
 * What a WebSocket close means for the room screen.
 *   'fatal' — a specific, final screen (kicked, room expired, policy, too big)
 *   'retry' — the network or the room's holders went away; back off and return
 *   'leave' — we asked for this (navigating away, pressing Leave)
 */
export function closeDisposition(code, deliberate) {
  if (deliberate) return 'leave'
  if (isFatalClose(code)) return 'fatal'
  return 'retry'
}

/** The screen a fatal close code belongs on. */
export function fatalCloseError(code) {
  if (code === 4003) return 'kicked'
  if (code === 4009) return 'replaced'
  if (code === 1001) return 'expired'
  if (code === 1009) return 'too_big'
  return 'policy' // 1008: rate limit, bad payload or the room was deleted
}

/**
 * Where the room screen goes after a connection attempt ends.
 *
 * The split that matters: a socket that **opened** and then dropped is a
 * network problem and is retried with backoff; a socket that **never opened**
 * means the handshake was rejected — the probe predicted success and the room
 * filled in between, or the network died at that instant — and neither is
 * helped by hammering it. That case becomes one generic message with a retry
 * button, so the client never invents a reason the browser cannot tell it.
 *
 * @param {object} o
 * @param {boolean} o.opened    the socket reached OPEN at least once
 * @param {boolean} o.deliberate we closed it (leave / navigate away)
 * @param {number}  o.code      the WebSocket close code
 * @param {number}  o.attempt   which connection attempt just ended (1-based)
 */
export function nextAfterClose({ opened = false, deliberate = false, code = 1006, attempt = 1 } = {}) {
  const disposition = closeDisposition(code, deliberate)

  if (disposition === 'leave') return { status: 'idle', error: null, attempt }
  if (disposition === 'fatal') return { status: 'error', error: fatalCloseError(code), attempt }

  if (!opened) return { status: 'error', error: 'join_failed', attempt }
  if (attempt >= MAX_RECONNECT_ATTEMPTS) return { status: 'error', error: 'retry_exhausted', attempt }

  return { status: 'reconnecting', error: null, attempt: attempt + 1, delay: reconnectDelay(attempt) }
}
