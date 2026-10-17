// Verify src/engine/overlay.js draws the flag emoji (from the country code)
// before the remote cursor name, and skips it when the country is missing or
// malformed. Plain node, fake 2d context:
//   node tests/overlay.test.mjs
import { drawCursors } from '../src/engine/overlay.js'

function makeCtx() {
  const texts = []
  const target = {
    measureText: (s) => ({ width: String(s).length * 6 }),
    fillText: (s) => {
      texts.push(s)
    },
  }
  const ctx = new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop] : () => {}),
    set: () => true,
  })
  return { ctx, texts }
}

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

const view = { x: 0, y: 0, scale: 1 }
const cursor = (over) => ({ x: 100, y: 100, alpha: 1, name: 'Ann', color: '#f00', country: 'DE', ...over })

function labelsFor(cursors) {
  const { ctx, texts } = makeCtx()
  drawCursors(ctx, cursors, view, 1000, 800)
  return texts
}

{
  const labels = labelsFor([cursor()])
  check('draws the flag emoji before the name', labels.length === 1 && labels[0] === '🇩🇪 Ann', labels.join('|'))
}

{
  const labels = labelsFor([cursor({ name: 'Bob', country: null })])
  check('skips the flag when country is missing', labels.length === 1 && labels[0] === 'Bob', labels.join('|'))
}

{
  const labels = labelsFor([cursor({ name: 'Cy', country: 'de' })])
  check('skips the flag for a code that is not two uppercase letters', labels.join('|') === 'Cy', labels.join('|'))
}

{
  const labels = labelsFor([cursor({ x: -1000, y: -1000 })])
  check('offscreen cursors are not labelled', labels.length === 0, labels.join('|'))
}

{
  const labels = labelsFor([
    cursor({ name: 'Ann', country: 'DE' }),
    cursor({ x: 200, y: 200, name: 'Bob', country: null, color: '#0f0' }),
  ])
  check('labels each cursor independently', labels.join('|') === '🇩🇪 Ann|Bob', labels.join('|'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
