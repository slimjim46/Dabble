// Unit tests for src/lib/viewUrl.js (Phase 7): shared-view params are
// untrusted, so every value must be parsed, bounded and clamped — and the link
// has to name a canvas point, so it survives being opened on a different
// screen. Plain node:
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

/** Canvas point at the centre of a parsed view, for one viewport. */
function centreOf(view, viewport) {
  return {
    cx: (viewport.width / 2 - view.x) / view.scale,
    cy: (viewport.height / 2 - view.y) / view.scale,
  }
}

{
  const v = parseViewParams('?cx=360&cy=166.7&z=1.5', vp)
  check('parses a valid view into screen offsets',
    v && v.x === 100 && Math.abs(v.y - 200) <= 0.1 && v.scale === 1.5, JSON.stringify(v))
  const c = v && centreOf(v, vp)
  check('puts the shared centre back where it started',
    c && Math.abs(c.cx - 360) < 1e-9 && Math.abs(c.cy - 166.7) < 0.1, JSON.stringify(c))
}

{
  const v = parseViewParams('?cx=100&cy=200', vp)
  check('defaults zoom to 1 when z is absent', v && v.scale === 1, JSON.stringify(v))
  check('centres the given canvas point on the screen',
    v && v.x === 540 && v.y === 250, JSON.stringify(v))
}

{
  const hi = parseViewParams('?cx=0&cy=0&z=999', vp)
  const lo = parseViewParams('?cx=0&cy=0&z=0.001', vp)
  check('clamps zoom to MAX_SCALE', hi && hi.scale === MAX_SCALE, JSON.stringify(hi))
  check('clamps zoom to MIN_SCALE', lo && lo.scale === MIN_SCALE, JSON.stringify(lo))
}

{
  const pastNear = parseViewParams('?cx=100000&cy=100000&z=1', vp)
  check('clamps a canvas point far off the near edge',
    pastNear && pastNear.x === MIN_VISIBLE - PAPER_SIZE && pastNear.y === MIN_VISIBLE - PAPER_SIZE,
    JSON.stringify(pastNear))
  const pastFar = parseViewParams('?cx=-100000&cy=-100000&z=1', vp)
  check('clamps a canvas point far off the far edge',
    pastFar && pastFar.x === vp.width - MIN_VISIBLE && pastFar.y === vp.height - MIN_VISIBLE,
    JSON.stringify(pastFar))
}

{
  check('null when cx or cy is missing',
    parseViewParams('?cx=1', vp) === null &&
    parseViewParams('?cy=1', vp) === null &&
    parseViewParams('', vp) === null)
}

{
  check('ignores the pre-cx/?x=&y= link format rather than misreading it',
    parseViewParams('?x=100&y=200&z=1.5', vp) === null)
}

{
  check('null for non-numeric coordinates',
    parseViewParams('?cx=abc&cy=2', vp) === null &&
    parseViewParams('?cx=1e999&cy=0', vp) === null &&
    parseViewParams('?cx=NaN&cy=Infinity&z=1', vp) === null)
}

{
  const view = { x: -200, y: -300, scale: 1.2 }
  const url = buildShareUrl('https://example.com/foo?old=1#frag', view, vp)
  check('buildShareUrl keeps origin+path and drops old params',
    url.startsWith('https://example.com/foo?') && !url.includes('old=') && !url.includes('#'), url)
  check('buildShareUrl names the canvas centre, not screen offsets',
    url.includes('cx=700') && url.includes('cy=625') && url.includes('z=1.200'), url)
  check('buildShareUrl never emits the old x/y params',
    !/[?&]x=/.test(url) && !/[?&]y=/.test(url), url)

  const parsed = parseViewParams(url.slice(url.indexOf('?')), vp)
  check('buildShareUrl output round-trips through the parser',
    parsed && Math.abs(parsed.x - (-200)) < 1e-6 && Math.abs(parsed.y - (-300)) < 1e-6 && parsed.scale === 1.2,
    JSON.stringify(parsed))
}

{
  // The whole point of encoding a centre: a narrower window must land on the
  // same place on the paper, not on the same screen offsets.
  const view = { x: 33.3, y: 77.7, scale: 2.75 }
  const url = buildShareUrl('https://example.com/', view, vp)
  const query = url.slice(url.indexOf('?'))

  const onSharer = centreOf(parseViewParams(query, vp), vp)
  const small = { width: 500, height: 400 }
  const onOther = centreOf(parseViewParams(query, small), small)
  const huge = { width: 2560, height: 1440 }
  const onThird = centreOf(parseViewParams(query, huge), huge)

  const wanted = centreOf(view, vp)
  const near = (got) => got && Math.abs(got.cx - wanted.cx) < 0.1 && Math.abs(got.cy - wanted.cy) < 0.1
  check('a different screen sees the same canvas spot (500x400)', near(onOther), JSON.stringify(onOther))
  check('a different screen sees the same canvas spot (2560x1440)', near(onThird), JSON.stringify(onThird))
  check('the sharer sees it too', near(onSharer), JSON.stringify(onSharer))
}

{
  check('buildShareUrl tolerates a non-URL href', buildShareUrl('nonsense', { x: 1, y: 2, scale: 1 }, vp) === 'nonsense')
}

{
  const href = 'https://example.com/foo?keep=1'
  check('buildShareUrl refuses a view with a non-finite offset',
    buildShareUrl(href, { x: NaN, y: 0, scale: 1 }, vp) === href)
  check('buildShareUrl refuses a view with a non-positive zoom',
    buildShareUrl(href, { x: 0, y: 0, scale: 0 }, vp) === href)
  check('buildShareUrl refuses a missing viewport instead of guessing a centre',
    buildShareUrl(href, { x: 0, y: 0, scale: 1 }, undefined) === href &&
    buildShareUrl(href, { x: 0, y: 0, scale: 1 }, { width: 0, height: 900 }) === href)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
