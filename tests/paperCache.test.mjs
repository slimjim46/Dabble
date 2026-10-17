// Unit tests for src/engine/paperCache.js (Phase 5b): the snapshot base image
// must sit under the vector strokes, and rebuild() must draw strokes in
// createdAt order. Plain node, no framework:
//   node tests/paperCache.test.mjs
import { PAPER_SIZE } from '../src/lib/constants.js'

// A recording 2d context; paperCache only needs these members.
function makeCtx() {
  const ops = []
  return {
    ops,
    ctx: {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      fillRect() {
        ops.push({ type: 'clear' })
      },
      drawImage() {
        ops.push({ type: 'image' })
      },
      beginPath() {},
      arc() {},
      fill() {
        ops.push({ type: 'paint', color: this.fillStyle, width: this.lineWidth })
      },
      moveTo() {},
      quadraticCurveTo() {},
      lineTo() {},
      stroke() {
        ops.push({ type: 'paint', color: this.strokeStyle, width: this.lineWidth })
      },
    },
  }
}

let current = null
globalThis.document = {
  createElement() {
    const { ctx, ops } = makeCtx()
    const canvas = { width: 0, height: 0, getContext: () => ctx }
    current = { canvas, ops }
    return canvas
  },
}

const { createPaperCache } = await import('../src/engine/paperCache.js')

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

function newPaper() {
  const paper = createPaperCache()
  return { paper, ops: current.ops, canvas: current.canvas }
}

const stroke = (id, color, createdAt, width = 6) => ({
  id,
  userId: 'u',
  userName: 'n',
  color,
  width,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
  createdAt,
})
const image = { width: PAPER_SIZE, height: PAPER_SIZE, tag: 'base' }

// initial -------------------------------------------------------------------
{
  const { ops, canvas } = newPaper()
  check('canvas is the paper size', canvas.width === PAPER_SIZE && canvas.height === PAPER_SIZE)
  check('starts as one white fill', ops.length === 1 && ops[0].type === 'clear')
}

// rebuild ordering ----------------------------------------------------------
{
  const { paper, ops } = newPaper()
  const a = stroke('a', '#111111', '2026-01-01T00:00:00Z')
  const b = stroke('b', '#222222', '2026-01-01T00:00:02Z')
  ops.length = 0
  paper.rebuild([b, a]) // unsorted input
  const painted = ops.filter((op) => op.type === 'paint').map((op) => op.color)
  check('rebuild clears then draws oldest -> newest', ops[0].type === 'clear' && painted.join(',') === '#111111,#222222', painted.join(','))
}

{
  const { paper, ops } = newPaper()
  const live = stroke('live', '#333333', undefined) // no created_at: drawn this session
  const old = stroke('old', '#444444', '2026-01-01T00:00:00Z')
  ops.length = 0
  paper.rebuild([live, old])
  const painted = ops.filter((op) => op.type === 'paint').map((op) => op.color)
  check('strokes without createdAt sort last', painted.join(',') === '#444444,#333333', painted.join(','))
}

// base + rebuild ------------------------------------------------------------
{
  const { paper, ops } = newPaper()
  ops.length = 0
  paper.setBase(image)
  check('setBase clears then paints the image', ops[0].type === 'clear' && ops[1].type === 'image' && ops.length === 2)
}

{
  const { paper, ops } = newPaper()
  paper.setBase(image)
  const a = stroke('a', '#111111', '2026-01-01T00:00:00Z')
  ops.length = 0
  paper.rebuild([a])
  check('rebuild paints base under the strokes',
    ops[0].type === 'clear' && ops[1].type === 'image' && ops[2].type === 'paint' && ops[2].color === '#111111',
    ops.map((op) => op.type).join(','))
}

{
  const { paper, ops } = newPaper()
  paper.setBase(image)
  paper.rebuild([stroke('a', '#111111', '2026-01-01T00:00:00Z')])
  ops.length = 0
  paper.rebuild([stroke('b', '#222222', '2026-01-01T00:00:01Z')])
  check('base survives later rebuilds (after a removal)',
    ops[0].type === 'clear' && ops[1].type === 'image' && ops[2].color === '#222222')
}

{
  const { paper, ops } = newPaper()
  paper.setBase(image)
  ops.length = 0
  paper.append(stroke('a', '#111111', undefined))
  check('append draws over the base without clearing',
    ops.length === 1 && ops[0].type === 'paint' && ops[0].color === '#111111')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
