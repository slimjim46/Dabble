// Unit tests for the rooms wire format: the colour PALETTE, the brush id, and
// the drift guard that keeps rooms/src/config.js PALETTE equal to COLORS in the
// plaza Toolbar. Pure unit tests, no network.
//
//   node tests/wire-unit.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BRUSH_IDS, PALETTE } from '../src/config.js'
import { buildSnapshot, parseStrokeEnd, parseStrokeStart } from '../src/wire.js'
import { check, summary } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const UUID = '11111111-2222-3333-4444-555555555555'

// ---- PALETTE drifts against the plaza Toolbar ------------------------------
// The plaza list is the source of truth for what a stroke may look like, so
// rooms duplicates it server-side. Read the .jsx as text (plain Node cannot
// import JSX) and fail the moment the two lists disagree.
function readToolbarColors() {
  const file = path.join(here, '..', '..', 'src', 'components', 'Toolbar.jsx')
  const src = readFileSync(file, 'utf8')
  const m = /const COLORS = \[([\s\S]*?)\n\]/.exec(src)
  if (!m) return null
  return [...m[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((x) => x[1].toLowerCase())
}

const toolbar = readToolbarColors()
check('Toolbar.jsx COLORS parsed', Array.isArray(toolbar) && toolbar.length > 0, JSON.stringify(toolbar))
check(
  'PALETTE matches Toolbar COLORS exactly (same members, same order)',
  Array.isArray(toolbar) && JSON.stringify(PALETTE) === JSON.stringify(toolbar),
  `config=${JSON.stringify(PALETTE)} toolbar=${JSON.stringify(toolbar)}`
)
check('PALETTE has no duplicates', new Set(PALETTE).size === PALETTE.length)
check('PALETTE is frozen', Object.isFrozen(PALETTE))
check('BRUSH_IDS is only 0 for now', JSON.stringify(BRUSH_IDS) === '[0]', JSON.stringify(BRUSH_IDS))

// ---- Colour validation -----------------------------------------------------
const start = (over = {}) => ({
  v: 1,
  t: 'stroke_start',
  k: 'k1',
  id: UUID,
  userId: 'u1',
  userName: 'A',
  color: '#e5484d',
  width: 3,
  pts: [1, 1],
  ...over,
})

for (const c of PALETTE) {
  check(`palette colour accepted: ${c}`, parseStrokeStart(start({ color: c }))?.color === c)
}
check('uppercase palette colour canonicalised', parseStrokeStart(start({ color: '#E5484D' }))?.color === '#e5484d')
check('hex but not in palette rejected', parseStrokeStart(start({ color: '#112233' })) === null)
check('another hex not in palette rejected', parseStrokeStart(start({ color: '#0000ff' })) === null)
check('named colour rejected', parseStrokeStart(start({ color: 'red' })) === null)
check('short hex rejected', parseStrokeStart(start({ color: '#fff' })) === null)
check('long hex rejected', parseStrokeStart(start({ color: '#e5484d0' })) === null)
check('non-string colour rejected', parseStrokeStart(start({ color: 123 })) === null)
check('null colour rejected', parseStrokeStart(start({ color: null })) === null)
check('missing colour rejected', parseStrokeStart(start({ color: undefined })) === null)

// ---- Brush id --------------------------------------------------------------
check('absent brush id means 0', parseStrokeStart(start())?.b === 0)
check('brush id 0 accepted', parseStrokeStart(start({ b: 0 }))?.b === 0)
check('brush id 1 rejected', parseStrokeStart(start({ b: 1 })) === null)
check('negative brush id rejected', parseStrokeStart(start({ b: -1 })) === null)
check('fractional brush id rejected', parseStrokeStart(start({ b: 1.5 })) === null)
check('string brush id rejected', parseStrokeStart(start({ b: '0' })) === null)
check('null brush id rejected', parseStrokeStart(start({ b: null })) === null)

// ---- stroke_end shape ------------------------------------------------------
const end = (strokeOver = {}) => ({
  v: 1,
  t: 'stroke_end',
  k: 'k1',
  stroke: {
    id: UUID,
    userId: 'u1',
    userName: 'A',
    color: '#e5484d',
    width: 3,
    points: [1, 1, 2, 2],
    ...strokeOver,
  },
})
const ended = (strokeOver) => parseStrokeEnd(end(strokeOver))?.stroke

check('final stroke: absent brush id means 0', ended()?.b === 0)
check('final stroke: brush id 0 accepted', ended({ b: 0 })?.b === 0)
check('final stroke: brush id 1 rejected', parseStrokeEnd(end({ b: 1 })) === null)
check('final stroke: colour canonicalised', ended({ color: '#E5484D' })?.color === '#e5484d')
check('final stroke: colour not in palette rejected', parseStrokeEnd(end({ color: '#112233' })) === null)
check('final stroke: missing colour rejected', parseStrokeEnd(end({ color: undefined })) === null)

// ---- snapshot builder (server -> client, v2 Phase 3) --------------------------
const snapshotStroke = (over = {}) => ({
  id: UUID,
  userId: 'u1',
  userName: 'A',
  color: '#e5484d',
  width: 3,
  points: [1, 1, 2, 2],
  ...over,
})

{
  const frame = buildSnapshot(3, true, [snapshotStroke()])
  check('snapshot: frame carries v, type, round and partial',
    frame.v === 1 && frame.t === 'snapshot' && frame.round === 3 && frame.partial === true,
    JSON.stringify({ v: frame.v, t: frame.t, round: frame.round, partial: frame.partial }))
  check('snapshot: strokes array passes through', frame.strokes.length === 1, String(frame.strokes.length))
  check('snapshot: an empty round builds an empty frame',
    buildSnapshot(1, false, []).strokes.length === 0)

  const canonical = buildSnapshot(1, false, [snapshotStroke({ color: '#E5484D' })]).strokes[0]
  check('snapshot: stored colour canonicalised like stroke_end', canonical?.color === '#e5484d', canonical?.color)
  check('snapshot: absent brush id materialises as 0', canonical?.b === 0, String(canonical?.b))

  const filtered = buildSnapshot(1, false, [
    snapshotStroke(),
    snapshotStroke({ id: 'not-a-uuid' }),
    snapshotStroke({ color: '#112233' }),
    snapshotStroke({ points: [1] }),
    null,
  ])
  check('snapshot: strokes failing the shape validator are dropped, valid ones kept',
    filtered.strokes.length === 1 && filtered.strokes[0].color === '#e5484d',
    String(filtered.strokes.length))
}

summary('wire-unit')
