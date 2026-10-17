// Unit tests for src/engine/hitTest.js. Plain node, no framework:
//   node tests/hitTest.test.mjs
import { distanceToStroke, hitTest } from '../src/engine/hitTest.js'

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

const stroke = (points, width = 6, id = 's') => ({
  id,
  userId: 'u',
  userName: 'n',
  color: '#000000',
  width,
  points,
})
const p = (x, y) => ({ x, y })

// distanceToStroke ---------------------------------------------------------
{
  const s = stroke([p(0, 0), p(100, 0)])
  check('perpendicular distance to a segment',
    Math.abs(distanceToStroke(s, 50, 10) - 10) < 1e-9,
    String(distanceToStroke(s, 50, 10)))
  check('distance clamps to the segment end',
    Math.abs(distanceToStroke(s, 150, 0) - 50) < 1e-9,
    String(distanceToStroke(s, 150, 0)))
  check('distance to a polyline takes the minimum',
    Math.abs(distanceToStroke(stroke([p(0, 0), p(100, 0), p(100, 100)]), 0, 50) - 50) < 1e-9)
  check('single-point stroke uses point distance',
    Math.abs(distanceToStroke(stroke([p(3, 4)]), 0, 0) - 5) < 1e-9)
  check('empty stroke is never hit',
    distanceToStroke(stroke([]), 0, 0) === Infinity)
}

// hitTest ------------------------------------------------------------------
const line = stroke([p(0, 0), p(1000, 0)], 6, 'line')

{
  // width/2 + 6/scale tolerance at scale 1 -> 3 + 6 = 9 world units
  check('inside tolerance hits', hitTest([line], p(500, 8), 1) === line)
  check('outside tolerance misses', hitTest([line], p(500, 10), 1) === null)
}

{
  // 6 screen px shrink to 6/scale world units when zoomed in
  const near = hitTest([line], p(500, 4), 4) // tolerance 3 + 1.5 = 4.5
  const far = hitTest([line], p(500, 5), 4)
  check('pad converts to world units at the current scale',
    near === line && far === null, `near=${!!near} far=${!!far}`)
}

{
  const a = stroke([p(0, 0), p(1000, 0)], 6, 'a')
  const b = stroke([p(0, 1), p(1000, 1)], 6, 'b') // 1 unit lower (overlapping tolerance)
  // Ties go to the newer stroke (b is last in the list).
  const tie = hitTest([a, b], p(500, 0.5), 1)
  check('tie goes to the newer stroke', tie === b, tie?.id)
}

{
  const nearOld = stroke([p(0, 0), p(1000, 0)], 40, 'nearOld') // wide, closest
  const farNew = stroke([p(0, 40), p(1000, 40)], 6, 'farNew')  // newer but farther
  const hit = hitTest([nearOld, farNew], p(500, 5), 1)
  check('nearest wins over newest', hit === nearOld, hit?.id)
}

{
  const s = stroke([p(0, 0), p(10, 0)], 6, 's')
  const viaIterable = hitTest(new Map([['k', s]]).values(), p(5, 0), 1)
  check('accepts any iterable of strokes', viaIterable === s)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
