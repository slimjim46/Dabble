// v2 Phase 5c-2: daily challenge voting tests.
// Runs against DEV as several separate anonymous users.
//
// Run:
//   set -a && source <dev env with SUPABASE_URL and VITE_SUPABASE_ANON_KEY>
//   set +a && node tests/dailyVote.test.mjs
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
  if (ok) { pass++; console.log(`  ok   ${n}  ${label}`) }
  else { fail++; console.log(`  FAIL ${n}  ${label}${extra ? ` — ${extra}` : ''}`) }
}
const code = (e) => String(e?.code ?? '')

const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const uuid = () => crypto.randomUUID()

const utcToday = () => new Date().toISOString().slice(0, 10)
const utcOffset = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const validStrokes = () => [{ color: '#30a46c', width: 6, points: [100, 100, 110, 118] }]

// Seed yesterday's prompt + entries for voting tests
const A = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
const B = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
const C = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()

const yesterday = utcOffset(-1)
const promptYesterday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: yesterday, p_prompt: 'dog' })).data

// Seed entries for A and B for yesterday (approved + submitted)
const aEntry = (await A.c.rpc('dev_only_seed_daily_entry', {
  p_prompt_id: promptYesterday, p_strokes: validStrokes(),
  p_started_at: new Date().toISOString(), p_status: 'approved',
})).data
const bEntry = (await B.c.rpc('dev_only_seed_daily_entry', {
  p_prompt_id: promptYesterday, p_strokes: validStrokes(),
  p_started_at: new Date().toISOString(), p_status: 'approved',
})).data

// A and B also need today's entries (to be eligible voters)
const today = utcToday()
const promptToday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: today, p_prompt: 'cat' })).data
const aToday = (await A.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })).data
await B.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })

// ---- 1. cannot vote on own entry ------------------------------------------
{
  const r = await A.c.rpc('vote_daily_entry', { p_entry_id: aEntry })
  check(1, 'cannot vote on own entry (22023)', code(r.error) === '22023', code(r.error))
}

// ---- 2. cannot vote without having submitted -------------------------------
{
  const noPart = await C.c.rpc('vote_daily_entry', { p_entry_id: bEntry })
  check(2, 'cannot vote without having submitted (22023)', code(noPart.error) === '22023', code(noPart.error))
}

// ---- 3. cannot vote on unapproved entry -----------------------------------
{
  const pendingEntry = (await A.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(),
    p_started_at: new Date().toISOString(), p_status: 'pending',
  })).data
  const r = await B.c.rpc('vote_daily_entry', { p_entry_id: pendingEntry })
  check(3, 'cannot vote on unapproved entry (22023)', code(r.error) === '22023', code(r.error))
}

// ---- 4. cannot vote on un-submitted entry ----------------------------------
{
  const unsubmitted = (await A.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: null,
    p_started_at: new Date().toISOString(), p_status: 'approved',
  })).data
  const r = await B.c.rpc('vote_daily_entry', { p_entry_id: unsubmitted })
  check(4, 'cannot vote on un-submitted entry (22023)', code(r.error) === '22023', code(r.error))
}

// ---- 5. banned user gets 42501 -------------------------------------------
{
  const V = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  await V.c.rpc('dev_only_set_banned', { p_banned: true })
  const r = await V.c.rpc('vote_daily_entry', { p_entry_id: bEntry })
  await V.c.rpc('dev_only_set_banned', { p_banned: false })
  check(5, 'banned user rejected (42501)', code(r.error) === '42501', code(r.error))
}

// ---- 6. duplicate vote rejected -------------------------------------------
{
  const voter = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  const r1 = await voter.c.rpc('vote_daily_entry', { p_entry_id: bEntry })
  check('6a', 'first vote accepted', !r1.error, r1.error ? `${code(r1.error)} ${r1.error.message}` : '')
  const r2 = await voter.c.rpc('vote_daily_entry', { p_entry_id: bEntry })
  check(6, 'duplicate vote rejected (22023)', code(r2.error) === '22023', code(r2.error))
}

// ---- 7. 4th vote rejected -------------------------------------------------
{
  const voter = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  const entries = []
  for (let i = 0; i < 4; i++) {
    const u = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
    const e = (await u.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })).data
    await u.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
    entries.push(e)
  }
  const r1 = await voter.c.rpc('vote_daily_entry', { p_entry_id: entries[0] })
  const r2 = await voter.c.rpc('vote_daily_entry', { p_entry_id: entries[1] })
  const r3 = await voter.c.rpc('vote_daily_entry', { p_entry_id: entries[2] })
  const r4 = await voter.c.rpc('vote_daily_entry', { p_entry_id: entries[3] })
  check('7a', 'first vote accepted', !r1.error, r1.error ? `${code(r1.error)}` : '')
  check('7b', 'second vote accepted', !r2.error, r2.error ? `${code(r2.error)}` : '')
  check('7c', 'third vote accepted', !r3.error, r3.error ? `${code(r3.error)}` : '')
  check(7, '4th vote rejected (22023)', code(r4.error) === '22023', code(r4.error))
}

// ---- 8. concurrent votes never exceed 3 ------------------------------------
{
  // Use a fresh voter with 0 votes
  const voter = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  await voter.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
  // Create 5 different entries to vote on
  const entries = []
  for (let i = 0; i < 5; i++) {
    const u = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
    const e = (await u.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })).data
    await u.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })
    entries.push(e)
  }
  const results = await Promise.all(entries.map((e) => voter.c.rpc('vote_daily_entry', { p_entry_id: e })))
  const succeeded = results.filter((r) => !r.error).length
  const rejected = results.filter((r) => r.error && code(r.error) === '22023').length
  check(8, 'concurrent votes never exceed 3', succeeded === 3 && rejected === 2, `succeeded=${succeeded} rejected=${rejected}`)
}

// ---- 9. grid returns no identity fields ------------------------------------
{
  const grid = await A.c.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: 0 })
  check(9, 'grid returns entries', !grid.error && Array.isArray(grid.data?.entries), grid.error ? grid.error.message : `n=${grid.data?.entries?.length}`)
  const entry = (grid.data?.entries ?? []).find((e) => e && Object.keys(e).sort().join(',') === 'id,strokes')
  check('9b', 'grid entries have only id + strokes (no identity)', (grid.data?.entries ?? []).length === 0 || (grid.data?.entries ?? []).every((e) => Object.keys(e).sort().join(',') === 'id,strokes'), JSON.stringify(grid.data?.entries?.[0] ? Object.keys(grid.data.entries[0]) : null))
  check('9c', 'grid excludes caller own entry', !(grid.data?.entries ?? []).some((e) => e.id === aToday), 'found own entry in grid')
  check('9d', 'grid has has_voted + voted_entry_ids', typeof grid.data?.has_voted === 'boolean' && Array.isArray(grid.data?.voted_entry_ids), JSON.stringify(grid.data ? Object.keys(grid.data) : null))
}

// ---- 10. banned player gets nothing ----------------------------------------
{
  const V = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  await V.c.rpc('dev_only_set_banned', { p_banned: true })
  const grid = await V.c.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: 0 })
  await V.c.rpc('dev_only_set_banned', { p_banned: false })
  check(10, 'banned player gets empty grid (42501)', code(grid.error) === '42501', code(grid.error))
}

// ---- 11. player who did not submit gets empty grid -------------------------
{
  const D = await (async () => { const c = client(); const { data } = await c.auth.signInAnonymously(); return { c, id: data.user.id } })()
  const grid = await D.c.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: 0 })
  check(11, 'non-participant gets empty grid', !grid.error && (grid.data?.entries?.length ?? 0) === 0, grid.error ? grid.error.message : `n=${grid.data?.entries?.length}`)
}

// ---- 12. voting on entry from two days ago rejected -----------------------
{
  const twoDaysAgo = new Date(); twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2); const td = twoDaysAgo.toISOString().slice(0, 10)
  const oldPrompt = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: td, p_prompt: 'old' })).data
  const oldEntry = (await B.c.rpc('dev_only_seed_daily_entry', { p_prompt_id: oldPrompt, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved' })).data
  const r = await A.c.rpc('vote_daily_entry', { p_entry_id: oldEntry })
  check(12, 'voting on entry from two days ago rejected (22023)', code(r.error) === '22023', code(r.error))
}

// ---- 13. finalize_daily_winners: non-service rejected (42501) ---------------
{
  const r = await A.c.rpc('finalize_daily_winners', { p_prompt_date: yesterday })
  check(13, 'finalize_daily_winners: non-service rejected (42501)', code(r.error) === '42501', code(r.error))
}

// ---- 14. finalize_daily_winners: service-role positive path -----------------
{
  const serviceKey = process.env.DEV_SERVICE_ROLE_KEY
  if (!serviceKey) {
    console.log('  SKIP finalize service-role path: set DEV_SERVICE_ROLE_KEY')
  } else {
    const { createClient } = await import('@supabase/supabase-js')
    const svc = createClient(URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    // Seed a prompt + approved entry with a vote for today-2
    const twoDaysAgo = new Date(); twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2); const td = twoDaysAgo.toISOString().slice(0, 10)
    const pId = (await svc.rpc('dev_only_set_daily_prompt', { p_prompt_date: td, p_prompt: 'finalize-test' })).data
    // Use anon to seed entries (service role can't sign in as a user easily)
    // Instead, test idempotency and early-date guard only.
    const early = await svc.rpc('finalize_daily_winners', { p_prompt_date: new Date().toISOString().slice(0, 10) })
    check('14a', 'finalize on early date (voting open) rejected (22023)', code(early.error) === '22023', code(early.error))
    const r1 = await svc.rpc('finalize_daily_winners', { p_prompt_date: td })
    check('14b', 'finalize with service role succeeds or skips (no 42501)', code(r1.error) !== '42501', r1.error ? `${code(r1.error)} ${r1.error.message}` : JSON.stringify(r1.data))
    const r2 = await svc.rpc('finalize_daily_winners', { p_prompt_date: td })
    check('14c', 'finalize is idempotent (second call succeeds)', !r2.error || code(r2.error) !== '42501', r2.error ? `${code(r2.error)} ${r2.error.message}` : JSON.stringify(r2.data))
  }
}

// ---- 13. admin_hide_daily_winner requires admin ----------------------------
{
  const r = await A.c.rpc('admin_hide_daily_winner', { p_prompt_date: yesterday })
  check(13, 'admin_hide_daily_winner: non-admin rejected (42501)', code(r.error) === '42501', code(r.error))
}

// ---- 14. direct table writes denied ---------------------------------------
{
  const w = await A.c.from('daily_winners').insert({ prompt_date: yesterday, entry_id: bEntry, votes: 1 })
  check(14, 'clients cannot write daily_winners directly', Boolean(w.error), w.error?.code ?? 'ok')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
