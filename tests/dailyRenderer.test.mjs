// v2 Phase 5c-3: daily winner renderer tests (no network).
//
// Run: node tests/dailyRenderer.test.mjs
import { renderWinner } from '../scripts/lib/renderWinner.js'

const IMG_SIZE = 1080

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')) }
}

// ---- 1. output is 1080x1080 -----------------------------------------------
{
  const canvas = renderWinner([], 'cat')
  check('renderer: output is 1080x1080', canvas.width === IMG_SIZE && canvas.height === IMG_SIZE, `${canvas.width}x${canvas.height}`)
}

// ---- 2. not blank (has non-white pixels when strokes present) ---------------
{
  const strokes = [{ color: '#30a46c', width: 6, points: [100, 100, 500, 500, 900, 100] }]
  const canvas = renderWinner(strokes, 'cat')
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE)
  let nonWhite = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++
  }
  check('renderer: has non-white pixels with strokes', nonWhite > 100, `nonWhite=${nonWhite}`)
}

// ---- 3. blank-ish canvas (empty strokes) is mostly white --------------------
{
  const canvas = renderWinner([], 'cat')
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE)
  let nonWhite = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++
  }
  // Prompt text adds some non-white pixels, but the paper itself is white.
  check('renderer: empty strokes -> mostly white', nonWhite < 50000, `nonWhite=${nonWhite}`)
}

// ---- 4. does not contain identity fields ------------------------------------
{
  // The renderWinner function signature only takes strokes + prompt + fontPath.
  // It never receives player_id, name, or country. Verify by checking the
  // function source doesn't reference identity fields.
  const src = (await import('node:fs')).readFileSync(new URL('../scripts/lib/renderWinner.js', import.meta.url), 'utf8')
  check('renderer: no identity fields in source', !src.includes('player_id') && !src.includes('userName') && !src.includes('country'), 'found identity reference')
}

// ---- 5. multiple strokes render without error -------------------------------
{
  const strokes = [
    { color: '#30a46c', width: 6, points: [100, 100, 500, 500] },
    { color: '#e5484d', width: 3, points: [200, 200, 800, 800] },
    { color: '#0090ff', width: 10, points: [0, 0, 2000, 2000] },
  ]
  const canvas = renderWinner(strokes, 'hello', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
  check('renderer: multi-stroke renders', canvas.width === IMG_SIZE && canvas.height === IMG_SIZE)
}

// ---- 6. null/undefined strokes handled -------------------------------------
{
  const canvas = renderWinner(null, 'test')
  check('renderer: null strokes handled', canvas.width === IMG_SIZE && canvas.height === IMG_SIZE)
  const canvas2 = renderWinner(undefined, null)
  check('renderer: undefined strokes + null prompt handled', canvas2.width === IMG_SIZE && canvas2.height === IMG_SIZE)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
