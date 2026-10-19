// Round stroke storage: the pure bookkeeping behind the `rs:` keys. No I/O
// here (unit-testable in plain Node); the Room DO owns the puts and deletes.
//
// One room = one current round. Every completed stroke is stored once under
// `rs:<zero-padded seq>` so storage.list() returns paint order, and the whole
// prefix is deleted at each round start. Caps bound a snapshot frame: once a
// round is partial, nothing more is stored for that round.
import { MAX_ROUND_BYTES, MAX_ROUND_POINTS, MAX_ROUND_STROKES, ROUND_KEY_PREFIX, ROUND_SEQ_PAD } from './config.js'

export function newRoundState(round = 1) {
  return { round, seq: 0, count: 0, points: 0, bytes: 0, partial: false }
}

/** Storage key for a sequence number. Zero-padded => list() = paint order. */
export function roundKey(seq) {
  return ROUND_KEY_PREFIX + String(seq).padStart(ROUND_SEQ_PAD, '0')
}

/** Points in a flat [x, y, ...] list, counted as x/y pairs. */
export function countRoundPoints(flat) {
  return flat.length / 2
}

/**
 * May one more stroke of this size be stored? False once the round is
 * partial (a breach is permanent for the round: the snapshot stays flagged).
 */
export function roundFits(state, bytes, points) {
  if (state.partial) return false
  return (
    state.count + 1 <= MAX_ROUND_STROKES &&
    state.points + points <= MAX_ROUND_POINTS &&
    state.bytes + bytes <= MAX_ROUND_BYTES
  )
}

/** Book the stroke in the round state. Synchronous: seq must never fork. */
export function recordRoundStroke(state, bytes, points) {
  state.seq += 1
  state.count += 1
  state.points += points
  state.bytes += bytes
}
