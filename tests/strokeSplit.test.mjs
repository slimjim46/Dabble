// Unit tests for the client stroke split (Phase 4 step 0b). Plain node:
//   node tests/strokeSplit.test.mjs
import {
  INK_SERVER_CAPACITY,
  MAX_LIVE_POINTS,
  MIN_SCALE,
  POINT_MIN_DIST_SCREEN,
  STROKE_SPLIT_COST,
} from '../src/lib/constants.js'
import { MAX_STROKE_WIDTH } from '../src/lib/strokeCodec.js'
import { segmentCost, strokeCost } from '../src/lib/stroke.js'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// The formula must match the server's stroke_path_length * width / 800.
{
  check('segmentCost matches segLen * width / 800',
    segmentCost(200, 6) === (200 * 6) / 800, String(segmentCost(200, 6)))
  check('strokeCost matches path length * width / 800',
    strokeCost([{ x: 0, y: 0 }, { x: 300, y: 400 }], 8) === (500 * 8) / 800)
  check('a zero-length stroke costs nothing', strokeCost([{ x: 1, y: 1 }], 40) === 0)
}

// The invariant that makes the split necessary: the client must close a
// stroke before its cost reaches the server's per-stroke capacity.
{
  check('STROKE_SPLIT_COST is below the server ink capacity',
    STROKE_SPLIT_COST < INK_SERVER_CAPACITY,
    `${STROKE_SPLIT_COST} vs ${INK_SERVER_CAPACITY}`)
}

// Mirror of extendStroke's split rule, used to walk a very long scribble.
function splitIntoPieces(segmentLengths, width) {
  const pieces = []
  let cost = 0
  let points = 0
  for (const segLen of segmentLengths) {
    cost += segmentCost(segLen, width)
    points += 1
    if (points >= MAX_LIVE_POINTS || cost >= STROKE_SPLIT_COST) {
      pieces.push(cost)
      cost = 0
      points = 0
    }
  }
  if (cost > 0) pieces.push(cost)
  return pieces
}

// The longest real segment: POINT_MIN_DIST_SCREEN screen px at the most
// zoomed-out scale, with the widest brush.
const maxSegmentLength = POINT_MIN_DIST_SCREEN / MIN_SCALE
const maxPieceOverhead = segmentCost(maxSegmentLength, MAX_STROKE_WIDTH)

{
  // A 5000-segment scribble with the widest brush at the maximum segment size.
  const segments = new Array(5000).fill(maxSegmentLength)
  const pieces = splitIntoPieces(segments, MAX_STROKE_WIDTH)
  const worst = Math.max(...pieces)
  check('a hostile-length stroke still splits into pieces',
    pieces.length > 1, `${pieces.length} pieces`)
  check('every piece stays under the server capacity',
    worst < INK_SERVER_CAPACITY, `worst piece ${worst.toFixed(3)}`)
  check('pieces split at, or just past, the split cost',
    worst <= STROKE_SPLIT_COST + maxPieceOverhead,
    `worst ${worst.toFixed(3)}`)
}

{
  // Belt and braces: the split threshold plus one max segment can never reach
  // the capacity the server enforces.
  check('split cost + one max segment < server capacity',
    STROKE_SPLIT_COST + maxPieceOverhead < INK_SERVER_CAPACITY,
    `${(STROKE_SPLIT_COST + maxPieceOverhead).toFixed(3)} vs ${INK_SERVER_CAPACITY}`)
}

{
  // A short stroke is never split.
  const pieces = splitIntoPieces([50, 50], 6)
  check('a short stroke stays one piece', pieces.length === 1 && pieces[0] < STROKE_SPLIT_COST)
}

{
  // The point-count split still happens for many tiny segments.
  const pieces = splitIntoPieces(new Array(MAX_LIVE_POINTS * 2).fill(0.01), 3)
  check('the point-count split still applies', pieces.length === 2, `${pieces.length} pieces`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
