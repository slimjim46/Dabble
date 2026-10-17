// Phase 6 acceptance tests: the 18 cases from SPEC-phases-3-4-6.md.
// Runs against DEV as several separate anonymous users (no service role).
//
// Prerequisites (already on dev):
//   - all Phase 3 + Phase 6 migrations applied
//   - supabase/dev/phase6_dev_only.sql applied (back-date helper + test term)
//
// Run:
//   set -a && source <dev env with SUPABASE_URL and VITE_SUPABASE_ANON_KEY>
//   set +a && node tests/rls.test.mjs
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and VITE_SUPABASE_ANON_KEY (dev project) first.')
  process.exit(1)
}

let pass = 0
let fail = 0
function check(n, label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${n}  ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${n}  ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

async function signIn(tag) {
  const c = client()
  const { data, error } = await c.auth.signInAnonymously()
  if (error) throw new Error(`${tag}: anonymous sign-in failed: ${error.message}`)
  return { c, id: data.user.id }
}

const uuid = () => crypto.randomUUID()
const makeStroke = (over = {}) => ({
  id: uuid(),
  user_name: 'Tester',
  color: '#30a46c',
  width: 6,
  points: [100, 100, 110, 118, 124, 104],
  hidden: false,
  ...over,
})
const code = (e) => String(e?.code ?? '')
const isPermanent = (c) => /^(22|23|42)/.test(c)

async function selectStroke(c, id) {
  const { data, error } = await c
    .from('strokes')
    .select('id,user_id,user_name,color,width,points,hidden,hidden_reason,report_count,reviewed')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`select failed: ${error.message}`)
  return data
}

const A = await signIn('A')
const B = await signIn('B')
console.log(`A = ${A.id}\nB = ${B.id}\n`)

// ---- 1 -------------------------------------------------------------------
const s1 = makeStroke({ user_id: B.id }) // spoofed id must be overwritten
{
  const s = s1
  const { error } = await A.c.from('strokes').insert(s)
  const row = error ? null : await selectStroke(A.c, s.id)
  check(1, 'A inserts a valid stroke; user_id is A even if B was sent',
    !error && row?.user_id === A.id,
    error ? error.message : `user_id=${row?.user_id}`)
}

// ---- 2 -------------------------------------------------------------------
{
  const s = makeStroke({ hidden: true })
  const { error } = await A.c.from('strokes').insert(s)
  const row = error ? null : await selectStroke(A.c, s.id)
  check(2, 'insert with hidden=true is stored as hidden=false',
    !error && row?.hidden === false,
    error ? error.message : `hidden=${row?.hidden}`)
}

// ---- 3 -------------------------------------------------------------------
{
  const cases = [
    ['points out of range', makeStroke({ points: [0, 0, 3000, 10] })],
    ['odd number of coordinates', makeStroke({ points: [0, 0, 5] })],
    ['non-numeric point', makeStroke({ points: [0, 0, 'x', 5] })],
    ['8001 numbers', makeStroke({ points: new Array(8001).fill(1) })],
  ]
  const wrong = []
  for (const [label, row] of cases) {
    const { error } = await A.c.from('strokes').insert(row)
    if (code(error) !== '22023') wrong.push(`${label} -> ${error ? code(error) || error.message : 'accepted'}`)
  }
  check(3, 'invalid points rejected with 22023 (4 variants)', wrong.length === 0, wrong.join('; '))
}

// ---- 4 -------------------------------------------------------------------
{
  const s = makeStroke({
    width: 40,
    points: [0, 0, 2000, 2000, 0, 2000, 2000, 0, 0, 0, 2000, 2000],
  })
  const { error } = await A.c.from('strokes').insert(s)
  check(4, 'stroke costing more than server capacity rejected with 22023',
    code(error) === '22023',
    error ? `${code(error)} ${error.message}` : 'accepted')
}

// Set up strokes used by later tests BEFORE the 100-stroke loop, because the
// strokes-per-minute limit is still hot right after it.
const s3 = makeStroke()
const sReport = makeStroke()
{
  const e1 = (await A.c.from('strokes').insert(s3)).error
  const e2 = (await A.c.from('strokes').insert(sReport)).error
  if (e1 || e2) throw new Error(`setup failed: ${e1?.message || e2?.message}`)
}

// ---- 5 -------------------------------------------------------------------
{
  let accepted = 0
  let throttled = 0
  const unexpected = []
  for (let i = 0; i < 100; i++) {
    const { error } = await A.c.from('strokes').insert(makeStroke())
    if (!error) accepted++
    else if (/^(PT429|P0001)$/.test(code(error))) throttled++
    else unexpected.push(code(error) || error.message)
  }
  check(5, '100 strokes in a tight loop: some throttled, none permanent',
    throttled > 0 && unexpected.length === 0,
    `accepted=${accepted} throttled=${throttled} unexpected=${unexpected.slice(0, 5).join(',')}`)
}

// ---- 6 -------------------------------------------------------------------
{
  const { error } = await A.c.from('strokes').update({ hidden: true }).eq('id', s3.id)
  const row = await selectStroke(A.c, s3.id)
  check(6, 'A hides own stroke: hidden with hidden_reason=undo',
    !error && row?.hidden === true && row?.hidden_reason === 'undo',
    error ? error.message : `hidden=${row?.hidden} reason=${row?.hidden_reason}`)
}

// ---- 7 -------------------------------------------------------------------
{
  await A.c.from('strokes').update({ hidden: false }).eq('id', s3.id)
  const row = await selectStroke(A.c, s3.id)
  check(7, 'A cannot un-hide own hidden stroke', row?.hidden === true,
    `hidden=${row?.hidden}`)
}

// ---- 8 -------------------------------------------------------------------
{
  const before = await selectStroke(A.c, s3.id)
  await A.c.from('strokes').update({ color: '#e5484d' }).eq('id', s3.id)
  await A.c.from('strokes').update({ points: [1, 2, 3, 4] }).eq('id', s3.id)
  await A.c.from('strokes').update({ user_name: 'Hax' }).eq('id', s3.id)
  const after = await selectStroke(A.c, s3.id)
  const unchanged =
    after?.color === before?.color &&
    JSON.stringify(after?.points) === JSON.stringify(before?.points) &&
    after?.user_name === before?.user_name
  check(8, 'A cannot update points / color / user_name on own stroke', unchanged,
    `color ${before?.color}->${after?.color} name ${before?.user_name}->${after?.user_name}`)
}

// ---- 9 -------------------------------------------------------------------
{
  const rowsB1 = await B.c.from('strokes').update({ hidden: true }).eq('id', s3.id).select('id')
  const rowsB2 = await B.c.from('strokes').update({ hidden: true }).eq('id', s1.id).select('id')
  const rowsB3 = await B.c.from('strokes').update({ color: '#000000' }).eq('id', sReport.id).select('id')
  const row = await selectStroke(A.c, s3.id)
  check(9, "B cannot update or hide A's strokes (0 rows affected)",
    (rowsB1.data?.length ?? 0) === 0 && (rowsB2.data?.length ?? 0) === 0 &&
      (rowsB3.data?.length ?? 0) === 0 && row?.hidden === true,
    `rows: ${rowsB1.data?.length},${rowsB2.data?.length},${rowsB3.data?.length} err:${rowsB1.error?.code || rowsB2.error?.code || rowsB3.error?.code || '-'}`)
}

// ---- 10 ------------------------------------------------------------------
{
  await A.c.from('strokes').delete().eq('id', s3.id)
  await B.c.from('strokes').delete().eq('id', sReport.id)
  const rowA = await selectStroke(A.c, s3.id)
  const rowB = await selectStroke(A.c, sReport.id)
  check(10, 'A and B cannot delete strokes', rowA !== null && rowB !== null,
    `s3=${rowA !== null} sReport=${rowB !== null}`)
}

// ---- 11 ------------------------------------------------------------------
{
  const tables = ['sessions', 'reports', 'ink_buckets', 'blocked_terms', 'admin_audit_log', 'session_durations']
  const bad = []
  for (const t of tables) {
    const { data, error } = await A.c.from(t).select('*').limit(1)
    if (!error && (data?.length ?? 0) > 0) bad.push(`${t}: returned ${data.length} rows`)
  }
  check(11, 'no client access to sessions/reports/ink_buckets/blocked_terms/admin_audit_log/session_durations',
    bad.length === 0, bad.join('; '))
}

// ---- 12 ------------------------------------------------------------------
{
  const attempts = [
    ['blocked term', 'xxbadwordxx'],
    ['zero-width character', 'Invi\u200Bsible'],
    ['25 characters', 'x'.repeat(25)],
  ]
  const wrong = []
  for (const [label, name] of attempts) {
    const { error } = await A.c.rpc('set_my_name', { new_name: name })
    if (code(error) !== '22023') wrong.push(`${label} -> ${error ? code(error) || error.message : 'accepted'}`)
  }
  const { error: okErr } = await A.c.rpc('set_my_name', { new_name: 'Cool Name' })
  const { data: player } = await A.c.from('players').select('name').eq('id', A.id).single()
  check(12, 'set_my_name rejects blocked/zero-width/25-char names, accepts a good one',
    wrong.length === 0 && !okErr && player?.name === 'Cool Name',
    `${wrong.join('; ')}${okErr ? ` ok-call: ${code(okErr)} ${okErr.message}` : ''} name=${player?.name}`)
}

// Reporters used by tests 13-15; created up-front, back-dated in test 14.
const reporters = []
for (const tag of ['R1', 'R2', 'R3']) reporters.push(await signIn(tag))

// ---- 13 ------------------------------------------------------------------
{
  const { data, error } = await B.c.rpc('report_stroke', { p_stroke_id: sReport.id })
  const row = await selectStroke(B.c, sReport.id)
  check(13, "B (younger than MIN_REPORTER_AGE) reports A's stroke: no effect",
    !error && row?.report_count === 0 && data?.hidden === false,
    error ? `${code(error)} ${error.message}` : `report_count=${row?.report_count}`)
}

// ---- 14 ------------------------------------------------------------------
{
  const hourAgo = new Date(Date.now() - 3600_000).toISOString()
  const wrong = []
  for (const R of reporters) {
    const { error } = await R.c.rpc('dev_only_backdate_player', {
      p_player_id: R.id,
      p_created_at: hourAgo,
    })
    if (error) wrong.push(`backdate: ${code(error)} ${error.message}`)
    const { error: repErr } = await R.c.rpc('report_stroke', { p_stroke_id: sReport.id })
    if (repErr) wrong.push(`report: ${code(repErr)} ${repErr.message}`)
  }
  const row = await selectStroke(A.c, sReport.id)
  check(14, 'three aged reporters hide the stroke (hidden_reason=reports)',
    wrong.length === 0 && row?.hidden === true && row?.hidden_reason === 'reports' && row?.report_count === 3,
    `${wrong.join('; ')} hidden=${row?.hidden} reason=${row?.hidden_reason} count=${row?.report_count}`)
}

// ---- 15 ------------------------------------------------------------------
{
  const own = await A.c.rpc('report_stroke', { p_stroke_id: sReport.id }) // own stroke
  const dup = await reporters[0].c.rpc('report_stroke', { p_stroke_id: sReport.id }) // already reported
  const row = await selectStroke(A.c, sReport.id)
  check(15, 'reporting own stroke / reporting twice: no effect',
    !own.error && !dup.error && row?.report_count === 3,
    `own=${JSON.stringify(own.data)} dup=${JSON.stringify(dup.data)} count=${row?.report_count}`)
}

// ---- 16, 17 --------------------------------------------------------------
const adminCalls = [
  ['admin_list_flagged', {}],
  ['admin_list_recent', {}],
  ['admin_hide_stroke', { p_id: uuid() }],
  ['admin_restore_stroke', { p_id: uuid() }],
  ['admin_ban_player', { p_user_id: A.id }],
  ['admin_unban_player', { p_user_id: A.id }],
]

{
  const wrong = []
  for (const [fn, args] of adminCalls) {
    const { error } = await A.c.rpc(fn, args)
    if (code(error) !== '42501') wrong.push(`${fn} -> ${error ? code(error) || error.message : 'accepted'}`)
  }
  check(16, 'non-admin authenticated user rejected by every admin_* RPC',
    wrong.length === 0, wrong.join('; '))
}

{
  // A signed-in user forges a role in user_metadata (which the user controls).
  const wrong = []
  const upd = await A.c.auth.updateUser({ data: { role: 'admin' } })
  if (upd.error) wrong.push(`forging user_metadata failed: ${upd.error.message}`)
  for (const [fn, args] of adminCalls) {
    const { error } = await A.c.rpc(fn, args)
    if (code(error) !== '42501') wrong.push(`${fn} -> ${error ? code(error) || error.message : 'accepted'}`)
  }
  // A never-signed-in client (Postgres role `anon`) gets rejected too.
  const noAuth = client()
  for (const [fn, args] of adminCalls) {
    const { error } = await noAuth.rpc(fn, args)
    if (!error) wrong.push(`${fn} as anon -> accepted`)
  }
  check(17, 'fake role in user_metadata rejected; anon (no session) rejected',
    wrong.length === 0, wrong.join('; '))
}

// ---- 18 ------------------------------------------------------------------
{
  const noAuth = client()
  const s = makeStroke()
  const { error } = await noAuth.from('strokes').insert(s)
  const { data } = await B.c.from('strokes').select('id').eq('id', s.id)
  check(18, 'anon role (no sign-in) cannot insert a stroke',
    Boolean(error) && (data?.length ?? 0) === 0,
    error ? code(error) : 'accepted')
}

// ---- Phase 4: 0a ---------------------------------------------------------
// Dev-only helper (supabase/dev/dev_only_delete_my_player.sql) removes only
// the caller's own players row, reproducing the "player row missing" bug.
{
  const T = await signIn('T') // fresh user: no strokes, no sessions
  const del = await T.c.rpc('dev_only_delete_my_player')
  const { data: gone } = await T.c.from('players').select('id').eq('id', T.id).maybeSingle()

  const { error: nameErr } = await T.c.rpc('set_my_name', { new_name: 'Phase4 Tester' })
  const { data: player } = await T.c.from('players').select('name').eq('id', T.id).single()

  const stroke = makeStroke()
  const { error: strokeErr } = await T.c.from('strokes').insert(stroke)
  const { data: saved } = await T.c.from('strokes').select('user_name').eq('id', stroke.id).maybeSingle()

  const U = await signIn('U') // second user cannot touch T's row
  const { error: foreignErr } = await U.c.rpc('dev_only_delete_my_player')
  const { data: stillThere } = await T.c.from('players').select('name').eq('id', T.id).maybeSingle()

  const noAuth = client() // no sign-in -> role anon, execute revoked
  const { error: anonErr } = await noAuth.rpc('dev_only_delete_my_player')

  check('0a', 'missing players row is recreated by set_my_name; name sticks and is used on the next stroke',
    !del.error && gone === null && !nameErr && player?.name === 'Phase4 Tester' &&
      !strokeErr && saved?.user_name === 'Phase4 Tester',
    `del=${del.error?.code || 'ok'} gone=${gone === null} name=${nameErr?.code || player?.name} stroke=${strokeErr?.code || saved?.user_name}`)
  check('0a-2', 'dev helper is self-only and unavailable to anon',
    !foreignErr && stillThere?.name === 'Phase4 Tester' && code(anonErr) === '42501',
    `foreign=${foreignErr?.code || 'ok'} name=${stillThere?.name} anon=${code(anonErr) || 'accepted'}`)
}

// ---- Phase 4: 4.3 --------------------------------------------------------
{
  const anonA = client()
  const { data: anonStats, error: anonErr } = await anonA.rpc('get_live_stats')
  const anonDenied = Boolean(anonErr) || anonStats === undefined

  const { data: stats, error: statsErr } = await A.c.rpc('get_live_stats')
  const statKeys = stats && typeof stats === 'object' ? Object.keys(stats).sort() : []
  const statShapeOk = statKeys.join(',') === 'countries,online,top_countries' &&
    typeof stats?.online === 'number' && typeof stats?.countries === 'number'
  const noUserIds = !JSON.stringify(stats ?? {}).includes(A.id)

  const { data: board, error: boardErr } = await A.c.rpc('get_country_leaderboard', { p_window: '24h' })
  const rowKeys = Array.isArray(board) && board[0] ? Object.keys(board[0]).sort() : []
  const boardShapeOk = Array.isArray(board) &&
    (board.length === 0 || rowKeys.join(',') === 'code,playtime_seconds,players,strokes')
  const noBoardLeak = !JSON.stringify(board ?? []).includes(A.id) &&
    !JSON.stringify(board ?? []).toLowerCase().includes('user_id')

  const { error: badWindow } = await A.c.rpc('get_country_leaderboard', { p_window: 'eternity' })

  check('4.3', 'stats RPCs return aggregates only, are authenticated-only and reject a bad window',
    anonDenied && !statsErr && statShapeOk && noUserIds && !boardErr && boardShapeOk && noBoardLeak && code(badWindow) === '22023',
    `anon=${code(anonErr) || 'accepted'} stats=${code(statsErr) || statKeys.join('/')} board=${code(boardErr) || rowKeys.join('/')} leak=${noUserIds && noBoardLeak} bad=${code(badWindow) || 'accepted'}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
