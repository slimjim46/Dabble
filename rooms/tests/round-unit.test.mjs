// Unit tests for round stroke storage (v2 Phase 3): the rs: key format, the
// round caps and the partial flag. Pure bookkeeping, no network.
//
//   node tests/round-unit.test.mjs
import { MAX_ROUND_BYTES, MAX_ROUND_POINTS, MAX_ROUND_STROKES, ROUND_KEY_PREFIX } from '../src/config.js'
import { countRoundPoints, newRoundState, recordRoundStroke, resetRoundState, roundFits, roundKey, roundPrefix } from '../src/round.js'
import { check, summary } from './helpers.mjs'

// ---- key format ------------------------------------------------------------
{
  check('key: prefix starts with rs:', roundKey(2, 3, 7).startsWith(ROUND_KEY_PREFIX), roundKey(2, 3, 7))
  check('key: game/round scoped', roundKey(2, 3, 7) === 'rs:g2:r3:000007', roundKey(2, 3, 7))
  check('key: seq 0', roundKey(1, 1, 0) === 'rs:g1:r1:000000', roundKey(1, 1, 0))
  check('key: prefix groups one round only', roundPrefix(2, 3) === 'rs:g2:r3:', roundPrefix(2, 3))
  check('key: consecutive rounds never share a prefix', !roundKey(1, 1, 5).startsWith(roundPrefix(1, 2)))
  check('key: consecutive games never share a prefix', !roundKey(1, 1, 5).startsWith(roundPrefix(2, 1)))
  const keys = []
  for (let i = 1; i <= MAX_ROUND_STROKES; i++) keys.push(roundKey(4, 2, i))
  const lexicographic = [...keys].sort()
  check('key: lexicographic order equals insertion order for every legal seq',
    JSON.stringify(keys) === JSON.stringify(lexicographic))
  check('key: every key fits inside the round cap count', keys.every((k) => k.length === roundPrefix(4, 2).length + 6))
}

// ---- state ------------------------------------------------------------------
{
  const s = newRoundState()
  check('state: a new room starts at round 1', s.round === 1, JSON.stringify(s))
  check('state: a new round is empty and not partial',
    s.seq === 0 && s.count === 0 && s.points === 0 && s.bytes === 0 && s.partial === false)
  const bumped = newRoundState(4)
  check('state: round number passes through', bumped.round === 4, String(bumped.round))
}

// ---- point counting ---------------------------------------------------------
check('points: one pair', countRoundPoints([1, 2]) === 1)
check('points: 4000 numbers are 2000 points', countRoundPoints(new Array(4000).fill(1)) === 2000)

// ---- caps --------------------------------------------------------------------
{
  const onePoint = countRoundPoints([1, 1])

  const fresh = newRoundState()
  check('caps: an empty round accepts a small stroke', roundFits(fresh, 100, onePoint) === true)

  const atStrokes = newRoundState()
  atStrokes.count = MAX_ROUND_STROKES
  check('caps: MAX_ROUND_STROKES strokes fit, one more does not',
    roundFits(atStrokes, 100, onePoint) === false)
  atStrokes.count = MAX_ROUND_STROKES - 1
  check('caps: the stroke before the count cap still fits', roundFits(atStrokes, 100, onePoint) === true)

  const atPoints = newRoundState()
  atPoints.points = MAX_ROUND_POINTS - 2
  check('caps: exactly MAX_ROUND_POINTS points fit', roundFits(atPoints, 100, 2) === true)
  check('caps: one point past MAX_ROUND_POINTS is refused', roundFits(atPoints, 100, 3) === false)

  const atBytes = newRoundState()
  atBytes.bytes = MAX_ROUND_BYTES - 100
  check('caps: exactly MAX_ROUND_BYTES fit', roundFits(atBytes, 100, onePoint) === true)
  check('caps: one byte past MAX_ROUND_BYTES is refused', roundFits(atBytes, 101, onePoint) === false)

  const partial = newRoundState()
  partial.partial = true
  check('caps: a partial round stores nothing more, whatever the size',
    roundFits(partial, 1, 1) === false)
}

// ---- recording up to the cap, then the permanent breach -----------------------
{
  const state = newRoundState()
  const keys = []
  let stored = 0
  // Small enough per stroke that the stroke-count cap binds first
  // (500 x 40 points = MAX_ROUND_POINTS; 500 x 500 B < MAX_ROUND_BYTES).
  while (roundFits(state, 500, 40)) {
    recordRoundStroke(state, 500, 40)
    keys.push(roundKey(1, 1, state.seq))
    stored++
  }
  check('full round: stops exactly at MAX_ROUND_STROKES', stored === MAX_ROUND_STROKES, String(stored))
  check('full round: counters agree with the strokes stored',
    state.count === MAX_ROUND_STROKES && state.seq === MAX_ROUND_STROKES &&
    state.points === MAX_ROUND_STROKES * 40 && state.bytes === MAX_ROUND_STROKES * 500,
    JSON.stringify(state))
  check('full round: keys stay in paint order', JSON.stringify(keys) === JSON.stringify([...keys].sort()))
  state.partial = true
  check('full round: once partial, nothing fits (the flag is permanent)',
    roundFits(state, 1, 1) === false)
}

// ---- reset ------------------------------------------------------------------
{
  const s = newRoundState(3)
  s.seq = 9
  s.count = 8
  s.points = 700
  s.bytes = 9000
  s.partial = true
  resetRoundState(s, 4)
  check('reset: keeps the new round and zeroes every counter',
    s.round === 4 && s.seq === 0 && s.count === 0 && s.points === 0 && s.bytes === 0 && s.partial === false,
    JSON.stringify(s))
  resetRoundState(s)
  check('reset: round defaults to the current one', s.round === 4, String(s.round))
}

summary('round-unit')
