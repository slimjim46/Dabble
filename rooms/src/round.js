// Round stroke storage: the pure bookkeeping behind the `rs:` keys. No I/O
// here (unit-testable in plain Node); the Room DO owns the puts and deletes.
//
// Keys are game/round scoped: `rs:g<gameSeq>:r<round>:<seq>`. A failed clear
// can therefore never leak strokes into the next round or the next game — the
// new prefix simply never lists them. Old step-1 `rs:<seq>` keys are orphaned
// and die with the room.
import { MAX_ROUND_BYTES, MAX_ROUND_POINTS, MAX_ROUND_STROKES, ROUND_KEY_PREFIX, ROUND_SEQ_PAD } from './config.js'

export function newRoundState(round = 1) {
  return { round, seq: 0, count: 0, points: 0, bytes: 0, partial: false }
}

/** Storage prefix for one round of one game. */
export function roundPrefix(gameSeq, round) {
  return `${ROUND_KEY_PREFIX}g${gameSeq}:r${round}:`
}

/** Storage key for a sequence number. Zero-padded => list() = paint order. */
export function roundKey(gameSeq, round, seq) {
  return roundPrefix(gameSeq, round) + String(seq).padStart(ROUND_SEQ_PAD, '0')
}

/** Zero the per-round caps, keeping `round` (used at every round start). */
export function resetRoundState(state, round = state.round) {
  state.round = round
  state.seq = 0
  state.count = 0
  state.points = 0
  state.bytes = 0
  state.partial = false
  return state
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
