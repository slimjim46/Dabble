// v2 Phase 5e: same-day daily voting tests.
// Runs against DEV as several separate anonymous users.
//
// Run:
//   set -a && source <dev env with SUPABASE_URL, VITE_SUPABASE_ANON_KEY and DEV_SERVICE_ROLE_KEY>
//   set +a && node tests/dailySameDayVote.test.mjs
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.DEV_SERVICE_ROLE_KEY
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
const signIn = async () => {
  const c = client()
  const { data, error } = await c.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`)
  return { c, id: data.user.id }
}
const utcToday = () => new Date().toISOString().slice(0, 10)
const utcOffset = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const validStrokes = () => [{ color: '#30a46c', width: 6, points: [100, 100, 110, 118] }]

const A = await signIn()
const B = await signIn()
const C = await signIn()

const today = utcToday()
const yesterday = utcOffset(-1)
const promptToday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: today, p_prompt: 'same-day' })).data
const promptYesterday = (await A.c.rpc('dev_only_set_daily_prompt', { p_prompt_date: yesterday, p_prompt: 'previous-day' })).data
if (!promptToday || !promptYesterday) throw new Error('dev_only_set_daily_prompt failed')

const aToday = (await A.c.rpc('dev_only_seed_daily_entry', {
  p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved',
})).data
const bToday = (await B.c.rpc('dev_only_seed_daily_entry', {
  p_prompt_id: promptToday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved',
})).data

async function findGridEntry(c, entryId) {
  for (let offset = 0; offset <= 500; offset += 12) {
    const grid = await c.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: offset })
    if (grid.error) return { error: grid.error }
    const entries = grid.data?.entries ?? []
    if (entries.some((e) => e.id === entryId)) return { grid: grid.data, entries }
    if (entries.length === 0) break
  }
  return { entries: [] }
}

// ---- 1. same-day approved entries are visible to eligible voters ------------
{
  const found = await findGridEntry(A.c, bToday)
  check(1, 'today grid includes another player approved entry', !!found.grid,
    found.error ? found.error.message : `n=${found.entries?.length ?? 0}`)
  check('1b', 'today grid excludes own entry', !(found.entries ?? []).some((e) => e.id === aToday))
  check('1c', 'grid reports no vote yet', found.grid?.has_voted === false &&
    !(found.grid?.voted_entry_ids ?? []).includes(bToday))
}

// ---- 2. vote on an approved entry from today --------------------------------
{
  const r = await A.c.rpc('vote_daily_entry', { p_entry_id: bToday })
  check(2, 'same-day approved vote accepted', !r.error, r.error ? `${code(r.error)} ${r.error.message}` : '')
  const grid = await A.c.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: 0 })
  check('2b', 'grid reflects the accepted vote',
    grid.data?.has_voted === true && (grid.data?.voted_entry_ids ?? []).includes(bToday),
    grid.error ? grid.error.message : JSON.stringify(grid.data?.voted_entry_ids))
  const dup = await A.c.rpc('vote_daily_entry', { p_entry_id: bToday })
  check('2c', 'duplicate same-day vote rejected (22023)', code(dup.error) === '22023', code(dup.error))
  const self = await A.c.rpc('vote_daily_entry', { p_entry_id: aToday })
  check('2d', 'self-vote rejected (22023)', code(self.error) === '22023', code(self.error))
  const noPart = await C.c.rpc('vote_daily_entry', { p_entry_id: bToday })
  check('2e', 'non-participant rejected (22023)', code(noPart.error) === '22023', code(noPart.error))
}

// ---- 3. yesterday remains approved-only (pending still rejected) ------------
{
  await A.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved',
  })
  const bYesterday = (await B.c.rpc('dev_only_seed_daily_entry', {
    p_prompt_id: promptYesterday, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'pending',
  })).data
  const r = await A.c.rpc('vote_daily_entry', { p_entry_id: bYesterday })
  check(3, 'yesterday pending entry still rejected (22023)', code(r.error) === '22023',
    r.error ? `${code(r.error)} ${r.error.message}` : '')
}

// ---- 4. finalize counts same-day votes, approved-only (pending excluded) ---
{
  const finalizeDate = '2000-01-01'
  if (!SERVICE_KEY) {
    console.log('  SKIP finalize same-day path: set DEV_SERVICE_ROLE_KEY')
  } else {
    const svc = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    let finalizePromptId

    const cleanup = async (promptId) => {
      await svc.from('daily_winners').delete().eq('prompt_date', finalizeDate)
      if (promptId) await svc.from('daily_entries').delete().eq('prompt_id', promptId)
      await svc.from('daily_prompts').delete().eq('prompt_date', finalizeDate)
    }

    try {
      const { data: stale } = await svc.from('daily_prompts').select('id').eq('prompt_date', finalizeDate).maybeSingle()
      await cleanup(stale?.id)

      finalizePromptId = (await A.c.rpc('dev_only_set_daily_prompt', {
        p_prompt_date: finalizeDate, p_prompt: 'same-day-finalize',
      })).data
      await A.c.rpc('dev_only_seed_daily_entry', {
        p_prompt_id: finalizePromptId, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved',
      })
      const approvedB = (await B.c.rpc('dev_only_seed_daily_entry', {
        p_prompt_id: finalizePromptId, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'approved',
      })).data
      const pendingD = (await C.c.rpc('dev_only_seed_daily_entry', {
        p_prompt_id: finalizePromptId, p_strokes: validStrokes(), p_started_at: new Date().toISOString(), p_status: 'pending',
      })).data

      const created = `${finalizeDate}T12:00:00Z`
      const { error: voteError } = await svc.from('daily_votes').insert([
        { entry_id: approvedB, voter_id: A.id, created_at: created },
        { entry_id: approvedB, voter_id: C.id, created_at: created },
        { entry_id: pendingD, voter_id: A.id, created_at: created },
        { entry_id: pendingD, voter_id: B.id, created_at: created },
        { entry_id: pendingD, voter_id: C.id, created_at: created },
      ])
      if (voteError) throw new Error(`seeding same-day votes failed: ${voteError.message}`)

      const fin = await svc.rpc('finalize_daily_winners', { p_prompt_date: finalizeDate })
      check(4, 'finalize picks the approved same-day winner (2 votes)', !fin.error &&
        fin.data?.entry_id === approvedB && fin.data?.votes === 2,
        fin.error ? `${code(fin.error)} ${fin.error.message}` : JSON.stringify(fin.data))
      check('4b', 'pending entry with more votes cannot win', fin.data?.entry_id !== pendingD,
        JSON.stringify(fin.data))
    } finally {
      await cleanup(finalizePromptId)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
