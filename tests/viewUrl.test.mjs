// Unit tests for src/lib/viewUrl.js (Phase 7): shared-view params are
// untrusted, so every value must be parsed, bounded and clamped. Plain node:
//   node tests/viewUrl.test.mjs
import { MAX_SCALE, MIN_VISIBLE, MIN_SCALE, PAPER_SIZE } from '../src/lib/constants.js'
import { buildShareUrl, parseViewParams } from '../src/lib/viewUrl.js'

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

const vp = { width: 1280, height: 900 }

{
  const v = parseViewParams('?x=100&y=200&z=1.5', vp)
  check('parses a valid view', v && v.x === 100 && v.y === 200 && v.scale === 1.5, JSON.stringify(v))
}

{
  const v = parseViewParams('?x=100&y=200', vp)
  check('defaults zoom to 1 when z is absent', v && v.scale === 1, JSON.stringify(v))
}

{
  const hi = parseViewParams('?x=0&y=0&z=999', vp)
  const lo = parseViewParams('?x=0&y=0&z=0.001', vp)
  check('clamps zoom to MAX_SCALE', hi && hi.scale === MAX_SCALE, JSON.stringify(hi))
  check('clamps zoom to MIN_SCALE', lo && lo.scale === MIN_SCALE, JSON.stringify(lo))
}

{
  const right = parseViewParams('?x=100000&y=100000&z=1', vp)
  check('clamps x/y to the far edge',
    right && right.x === 1280 - MIN_VISIBLE && right.y === 900 - MIN_VISIBLE, JSON.stringify(right))
  const left = parseViewParams('?x=-100000&y=-100000&z=1', vp)
  check('clamps x/y to the near edge',
    left && left.x === MIN_VISIBLE - PAPER_SIZE && left.y === MIN_VISIBLE - PAPER_SIZE, JSON.stringify(left))
}

{
  check('null when x or y is missing',
    parseViewParams('?x=1', vp) === null &&
    parseViewParams('?y=1', vp) === null &&
    parseViewParams('', vp) === null)
}

{
  check('null for non-numeric coordinates',
    parseViewParams('?x=abc&y=2', vp) === null &&
    parseViewParams('?x=1e999&y=0', vp) === null &&
    parseViewParams('?x=NaN&y=Infinity&z=1', vp) === null)
}

{
  const url = buildShareUrl('https://example.com/foo?old=1#frag', { x: 123.6, y: -45.2, scale: 2.5 })
  check('buildShareUrl keeps origin+path and drops old params',
    url.startsWith('https://example.com/foo?') && !url.includes('old=') && !url.includes('#'), url)
  const q = url.slice(url.indexOf('?'))
  const v = parseViewParams(q, { width: 5000, height: 5000 })
  check('buildShareUrl output round-trips through the parser',
    v && v.x === 124 && v.y === -45 && v.scale === 2.5, JSON.stringify(v))
}

{
  check('buildShareUrl tolerates a non-URL href', buildShareUrl('nonsense', { x: 1, y: 2, scale: 1 }) === 'nonsense')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
