// v2 Phase 5a acceptance tests: daily challenge schema + RPCs + RLS.
// Runs against DEV as several separate anonymous users (no service role).
//
// Prerequisites (already on dev):
//   - all migrations through 20261021170000_phase5a_daily.sql applied
//   - supabase/dev/phase5a_daily_dev_only.sql applied
//
// Run:
//   set -a && source <dev env with SUPABASE_URL and VITE_SUPABASE_ANON_KEY>
//   set +a && node tests/daily.test.mjs
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
const code = (e) => String(e?.code ?? '')

// UTC date helpers (the challenge day is the UTC date).
const utcToday = () => new Date().toISOString().slice(0, 10)
const utcOffset = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const makeStroke = (over = {}) => ({
  color: '#30a46c',
  width: 6,
  points: [100, 100, 110, 118, 124, 104],
  ...over,
})
const validStrokes = () => [makeStroke(), makeStroke()]

const A = await signIn('A')
const B = await signIn('B')
console.log(`A = ${A.id}\nB = ${B.id}\n`)

// ---- prompts (owner-supplied; tests seed them via the dev helper) ----------
const promptToday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: utcToday(), p_prompt: 'cat' })).data
const promptYesterday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: utcOffset(-1), p_prompt: 'dog' })).data
const promptTomorrow = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: utcOffset(1), p_prompt: 'bird' })).data
if (!promptToday || !promptYesterday || !promptTomorrow) {
  throw new Error('dev_only_set_daily_prompt failed to seed prompts')
}

// ---- 1 -------------------------------------------------------------------
{
  const { data, error } = await A.c.from('daily_prompts').select('id')
  const ids = new Set((data ?? []).map((p) => p.id))
  check(1, 'clients can read today and past prompts, never future ones',
    !error && ids.has(promptToday) && ids.has(promptYesterday) && !ids.has(promptTomorrow),
    error ? error.message : `hasTomorrow=${ids.has(promptTomorrow)}`)
}

// ---- 2, 3 -----------------------------------------------------------------
{
  const start = await A.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  check(2, 'start_daily_attempt records a server start time',
    !start.error && !!start.data?.entry_id && !!start.data?.started_at,
    start.error ? `${code(start.error)} ${start.error.message}` : JSON.stringify(start.data))

  const ok = await A.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check(3, 'submit valid strokes inside the window is accepted', !ok.error, ok.error ? `${code(ok.error)} ${ok.error.message}` : '')
}

// ---- 4, 5 -----------------------------------------------------------------
{
  const again = await A.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check(4, 'a second submit is rejected (22023)', code(again.error) === '22023', code(again.error))

  const noStart = await B.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check(5, 'submit without starting is rejected (22023)', code(noStart.error) === '22023', code(noStart.error))
}

// ---- 6 -------------------------------------------------------------------
{
  const notToday = await B.c.rpc('start_daily_attempt', { p_prompt_id: promptYesterday })
  check(6, 'start for a non-today prompt is rejected (22023)', code(notToday.error) === '22023', code(notToday.error))
}

// ---- 7 (invalid strokes) --------------------------------------------------
{
  const X = await signIn('X')
  await X.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  const cases = [
    ['not an array', { a: 1 }],
    ['bad color', [makeStroke({ color: 'red' })]],
    ['width out of range', [makeStroke({ width: 100 })]],
    ['too many point numbers', [makeStroke({ points: new Array(8001).fill(1) })]],
    ['point out of range', [makeStroke({ points: [0, 0, 3000, 10] })]],
    ['odd number of coordinates', [makeStroke({ points: [0, 0, 5] })]],
    ['non-numeric point', [makeStroke({ points: [0, 0, 'x', 5] })]],
  ]
  const wrong = []
  for (const [label, strokes] of cases) {
    const { error } = await X.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: strokes })
    if (code(error) !== '22023') wrong.push(`${label} -> ${error ? code(error) || error.message : 'accepted'}`)
  }
  check(7, 'oversize/invalid strokes rejected with 22023 (7 variants)', wrong.length === 0, wrong.join('; '))

  const after = await X.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check('7b', 'a valid submit still works after rejected ones', !after.error, after.error ? `${code(after.error)}` : '')
}

// ---- 8 (too many strokes) -------------------------------------------------
{
  const Y = await signIn('Y')
  await Y.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  const many = new Array(121).fill(makeStroke())
  const { error } = await Y.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: many })
  check(8, 'more than 2x max_strokes_per_minute rejected before processing (22023)', code(error) === '22023', code(error))
}

// ---- 9 (ink budget) -------------------------------------------------------
{
  const Z = await signIn('Z')
  await Z.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  // 16 strokes x cost 100 (length 2000, width 40) = 1600 > 150 + 12*120 = 1590.
  const big = new Array(16).fill(makeStroke({ width: 40, points: [0, 0, 2000, 0] }))
  const { error } = await Z.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: big })
  check(9, 'an entry exceeding the ink budget is rejected (22023)', code(error) === '22023', code(error))
}

// ---- 10 (window + grace) --------------------------------------------------
{
  const W1 = await signIn('W1')
  await W1.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptToday, p_strokes: null,
    p_started_at: new Date(Date.now() - (120 + 5) * 1000).toISOString(), p_status: 'pending',
  })
  const inside = await W1.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check(10, 'submit inside the grace window is accepted', !inside.error, inside.error ? `${code(inside.error)} ${inside.error.message}` : '')

  const W2 = await signIn('W2')
  await W2.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptToday, p_strokes: null,
    p_started_at: new Date(Date.now() - (120 + 11) * 1000).toISOString(), p_status: 'pending',
  })
  const after = await W2.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  check('10b', 'submit just past the grace window is rejected (22023)', code(after.error) === '22023', code(after.error))
}

// ---- 11 (concurrent submits) ----------------------------------------------
{
  const P = await signIn('P')
  await P.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  const [r1, r2] = await Promise.all([
    P.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() }),
    P.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() }),
  ])
  const oneWins = (!r1.error && code(r2.error) === '22023') || (!r2.error && code(r1.error) === '22023')
  check(11, 'two concurrent submits: exactly one wins', oneWins, `${code(r1.error)} / ${code(r2.error)}`)
}

// ---- 12 (missing players row) ---------------------------------------------
{
  const G = await signIn('G')
  await G.c.rpc('dev_only_delete_my_player')
  const start = await G.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  const { data: player } = await G.c.from('players').select('id').eq('id', G.id).maybeSingle()
  check(12, 'start_daily_attempt recreates a missing players row (no 23503)',
    !start.error && !!start.data?.entry_id && player?.id === G.id,
    start.error ? `${code(start.error)} ${start.error.message}` : `player=${player?.id === G.id}`)
}

// ---- 13 (banned) ----------------------------------------------------------
{
  const V = await signIn('V')
  await V.c.rpc('dev_only_set_banned', { p_banned: true })
  const s = await V.c.rpc('start_daily_attempt', { p_prompt_id: promptToday })
  const sub = await V.c.rpc('submit_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes() })
  const vote = await V.c.rpc('vote_daily_entry', { p_entry_id: uuid() })
  await V.c.rpc('dev_only_set_banned', { p_banned: false })
  check(13, 'a banned player cannot start, submit or vote (42501)',
    code(s.error) === '42501' && code(sub.error) === '42501' && code(vote.error) === '42501',
    `${code(s.error)} / ${code(sub.error)} / ${code(vote.error)}`)
}

// ---- 14 (own-rows select policy) ------------------------------------------
{
  const aEntry = (await A.c.from('daily_entries').select('id').eq('player_id', A.id)).data ?? []
  check(14, 'A reads their own entries', aEntry.length >= 1, `n=${aEntry.length}`)

  const bSees = (await B.c.from('daily_entries').select('id').eq('player_id', A.id)).data ?? []
  check('14b', 'B cannot select A entries (own rows only)', bSees.length === 0, `n=${bSees.length}`)

  const aId = aEntry[0]?.id
  await A.c.rpc('dev_only_approve_daily_entry', { p_entry_id: aId })
  const bSeesApproved = (await B.c.from('daily_entries').select('id').eq('player_id', A.id)).data ?? []
  check('14c', 'B still cannot select A entries even when approved', bSeesApproved.length === 0, `n=${bSeesApproved.length}`)
}

// ---- 15 (votes) -----------------------------------------------------------
{
  const aYesterday = (await A.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(),
    p_started_at: new Date().toISOString(), p_status: 'approved',
  })).data
  const bYesterday = (await B.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(),
    p_started_at: new Date().toISOString(), p_status: 'pending',
  })).data

  const pending = await A.c.rpc('vote_daily_entry', { p_entry_id: bYesterday })
  check(15, 'voting on a pending entry is rejected (22023)', code(pending.error) === '22023', code(pending.error))

  await B.c.rpc('dev_only_approve_daily_entry', { p_entry_id: bYesterday })
  const ok = await A.c.rpc('vote_daily_entry', { p_entry_id: bYesterday })
  check('15b', 'after approval the vote is accepted', !ok.error, ok.error ? `${code(ok.error)} ${ok.error.message}` : '')

  const dup = await A.c.rpc('vote_daily_entry', { p_entry_id: bYesterday })
  check('15c', 'a double vote is rejected (22023)', code(dup.error) === '22023', code(dup.error))

  const self = await A.c.rpc('vote_daily_entry', { p_entry_id: aYesterday })
  check('15d', 'a self-vote is rejected (22023)', code(self.error) === '22023', code(self.error))

  const C = await signIn('C')
  const noPart = await C.c.rpc('vote_daily_entry', { p_entry_id: bYesterday })
  check('15e', 'voting without having submitted that day is rejected (22023)', code(noPart.error) === '22023', code(noPart.error))

  const bToday = (await B.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptToday, p_strokes: validStrokes(),
    p_started_at: new Date().toISOString(), p_status: 'approved',
  })).data
  const today = await A.c.rpc('vote_daily_entry', { p_entry_id: bToday })
  check('15f', "voting on today's approved entry is accepted", !today.error, today.error ? `${code(today.error)} ${today.error.message}` : '')

  const D = await signIn('D')
  const dYesterday = (await D.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(),
    p_started_at: new Date().toISOString(), p_status: 'rejected',
  })).data
  const rejected = await A.c.rpc('vote_daily_entry', { p_entry_id: dYesterday })
  check('15g', 'voting on a rejected entry is rejected (22023)', code(rejected.error) === '22023', code(rejected.error))

  const F = await signIn('F')
  const fYesterday = (await F.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: null,
    p_started_at: new Date().toISOString(), p_status: 'pending',
  })).data
  const unsubmitted = await A.c.rpc('vote_daily_entry', { p_entry_id: fYesterday })
  check('15h', 'voting on an unsubmitted entry is rejected (22023)', code(unsubmitted.error) === '22023', code(unsubmitted.error))
}

// ---- 16 (admin RPC guard) -------------------------------------------------
{
  const nonAdmin = await A.c.rpc('admin_review_daily_entry', { p_entry_id: uuid(), p_approve: true })
  check(16, 'a non-admin is rejected by admin_review_daily_entry (42501)', code(nonAdmin.error) === '42501', code(nonAdmin.error))

  const noAuth = client()
  const anon = await noAuth.rpc('admin_review_daily_entry', { p_entry_id: uuid(), p_approve: true })
  check('16b', 'an anon (no session) is rejected too', Boolean(anon.error), code(anon.error) || 'accepted')
}

// ---- 17 (direct table writes denied) --------------------------------------
{
  const e = await A.c.from('daily_entries').insert({ prompt_id: promptToday, player_id: A.id, strokes: [] })
  const v = await A.c.from('daily_votes').insert({ entry_id: uuid(), voter_id: A.id })
  const p = await A.c.from('daily_prompts').insert({ prompt_date: utcOffset(3), prompt: 'hack' })
  check(17, 'clients cannot write daily_entries / daily_votes / daily_prompts directly',
    Boolean(e.error) && Boolean(v.error) && Boolean(p.error),
    `${e.error?.code ?? 'ok'}/${v.error?.code ?? 'ok'}/${p.error?.code ?? 'ok'}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
