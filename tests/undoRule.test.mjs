// Unit tests for the Phase 5b undo rule: undo/canUndo only consider strokes
// that are in the store (newer than the snapshot cutoff, or drawn this
// session). A stroke baked into the snapshot is not in the store, so it can
// never be "undone". Plain node, no framework:
//   node tests/undoRule.test.mjs
import { createStrokeStore } from '../src/engine/strokeStore.js'

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

const stroke = (id, userId, createdAt) => ({
  id,
  userId,
  userName: 'n',
  color: '#000000',
  width: 6,
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ],
  createdAt,
})

// No store entries at all -> nothing to undo (same as no snapshot).
{
  const store = createStrokeStore()
  check('empty store: canUndo is false', store.hasOwn('me') === false && store.lastOwn('me') === null)
}

// The baked stroke exists in the database but is NOT in the store.
// Only a newer own stroke (the one drawn this session) is undoable.
{
  const store = createStrokeStore()
  const baked = stroke('baked', 'me', '2020-01-01T00:00:00Z')
  const mine = stroke('mine', 'me', '2026-01-01T00:00:00Z')
  store.add(mine)

  check('baked stroke is not in the store', store.has('baked') === false)
  check('canUndo sees the in-store stroke', store.hasOwn('me') === true)
  check('lastOwn never returns a baked stroke', store.lastOwn('me')?.id === 'mine', store.lastOwn('me')?.id)

  // Undo removes the newest in-store own stroke; the baked one is untouched.
  store.remove(mine.id)
  check('after undoing the session stroke there is nothing left to undo',
    store.hasOwn('me') === false && store.lastOwn('me') === null)
  check('the baked stroke was never in the store to remove', store.has(baked.id) === false)
}

// lastOwn returns the newest in-store own stroke, ignoring other people.
{
  const store = createStrokeStore()
  store.add(stroke('old', 'me', '2026-01-01T00:00:00Z'))
  store.add(stroke('other', 'them', '2026-01-01T00:00:05Z'))
  store.add(stroke('new', 'me', '2026-01-01T00:00:10Z'))
  check('lastOwn ignores other users and picks the newest own', store.lastOwn('me')?.id === 'new')
  check('hasOwn is false for a user with no strokes', store.hasOwn('nobody') === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
