// Phase 3 acceptance smoke test: the existing app's database flows still work
// against the migrated DEV project. Mirrors what src/lib does — load, insert,
// undo (hide own stroke), and the owners-can-see-their-own-hidden-rows rule.
// Run: set -a && source <dev env> && set +a && node tests/phase3-acceptance.mjs
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and VITE_SUPABASE_ANON_KEY (dev project) first.')
  process.exit(1)
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

const PAGE = 1000
const CAP = 5000

async function loadVisible(supabase) {
  const rows = []
  let from = 0
  while (rows.length < CAP) {
    const to = Math.min(rows.length + PAGE, CAP) - 1
    const { data, error } = await supabase
      .from('strokes')
      .select('id,user_id,user_name,color,width,points,hidden,created_at')
      .eq('hidden', false)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw new Error(`load failed: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } })
const { data: auth, error: signInError } = await supabase.auth.signInAnonymously()
check('anonymous sign-in', !signInError, signInError?.message)
const uid = auth.user.id

// 1. Load history (what the app does on startup).
const history = await loadVisible(supabase)
check('loads existing visible strokes', history.length > 0, `got ${history.length}`)

// 2. Draw: insert a stroke as myself (user_id comes from auth.uid() default).
const myStroke = {
  id: crypto.randomUUID(),
  user_name: 'Smoke Test',
  color: '#0090ff',
  width: 6,
  points: [100, 100, 140, 160, 200, 120, 260, 220],
  hidden: false,
}
const { error: insertError } = await supabase.from('strokes').insert(myStroke)
check('insert own stroke (draw + save)', !insertError, insertError?.message)

// 3. It is visible to me and matches auth.uid().
const { data: mine, error: readErr } = await supabase
  .from('strokes')
  .select('id,user_id,hidden')
  .eq('id', myStroke.id)
  .single()
check('reads back own stroke', !readErr && mine?.id === myStroke.id, readErr?.message)
check('user_id is my auth uid', mine?.user_id === uid, `got ${mine?.user_id} want ${uid}`)

// 4. Undo: set hidden = true on my own stroke.
const { error: hideErr } = await supabase
  .from('strokes')
  .update({ hidden: true })
  .eq('id', myStroke.id)
check('undo hides own stroke', !hideErr, hideErr?.message)

// 5. The history load no longer returns it.
const afterUndo = await loadVisible(supabase)
check('hidden stroke gone from history load', !afterUndo.some((r) => r.id === myStroke.id))

// 6. I can still see my OWN hidden stroke (needed so undo never errors).
const { data: hiddenMine, error: hiddenReadErr } = await supabase
  .from('strokes')
  .select('id,hidden')
  .eq('id', myStroke.id)
  .single()
check(
  'owner still sees own hidden stroke',
  !hiddenReadErr && hiddenMine?.hidden === true,
  hiddenReadErr?.message,
)

// 7. A second anonymous user cannot see or touch my hidden stroke (RLS sanity).
const other = createClient(URL, KEY, { auth: { persistSession: false } })
await other.auth.signInAnonymously()
const { data: otherSees, error: otherErr } = await other
  .from('strokes')
  .select('id')
  .eq('id', myStroke.id)
check(
  'other user cannot see my hidden stroke',
  !otherErr && (otherSees?.length ?? 0) === 0,
  otherErr?.message ?? `saw ${otherSees?.length}`,
)

const { data: otherUpdate } = await other
  .from('strokes')
  .update({ hidden: false })
  .eq('id', myStroke.id)
  .select('id')
check('other user cannot unhide my stroke', (otherUpdate?.length ?? 0) === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
