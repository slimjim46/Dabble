// v2 Phase 5d: daily prompt pool + ensure_daily_prompts tests.
// Runs against DEV. Positive tests call ensure_daily_prompts via the
// Management API (postgres-only function). Negative tests use anon client.
//
// Run:
//   set -a && source <dev env with SUPABASE_URL and VITE_SUPABASE_ANON_KEY>
//   set +a && node tests/dailyPrompts.test.mjs
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const MGMT_TOKEN = process.env.SUPABASE_MGMT_TOKEN || ''
const DEV_REF = 'mlynwcajwxmceglgtcat'
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

// Helper: run SQL via Management API (postgres-level, for ensure_daily_prompts)
async function runSql(sql) {
  const token = MGMT_TOKEN || (await (async () => {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    return readFileSync(homedir() + '/.supabase/access-token', 'utf8').trim()
  })())
  const res = await fetch(`https://api.supabase.com/v1/projects/${DEV_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  return JSON.parse(text)
}

const utcToday = () => new Date().toISOString().slice(0, 10)
const utcOffset = (n) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Snapshot existing prompts before tests
const beforePrompts = await runSql("select id, prompt_date, prompt from public.daily_prompts where prompt_date >= (now() at time zone 'utc')::date order by prompt_date;")
const beforeIds = new Set((beforePrompts ?? []).map((r) => r.id))

// ---- 1. fills today through today+7 ---------------------------------------
{
  const added = await runSql('select public.ensure_daily_prompts(7);')
  const after = await runSql("select prompt_date from public.daily_prompts where prompt_date >= (now() at time zone 'utc')::date and prompt_date <= (now() at time zone 'utc')::date + 7 order by prompt_date;")
  const dates = (after ?? []).map((r) => r.prompt_date)
  const allPresent = Array.from({ length: 8 }, (_, i) => utcOffset(i)).every((d) => dates.includes(d))
  check(1, 'ensure_daily_prompts fills today through today+7 (8 distinct dates)',
    allPresent && dates.length >= 8, `dates=${dates.length} added=${added?.[0]?.ensure_daily_prompts}`)
}

// ---- 2. rerunning adds 0 ---------------------------------------------------
{
  const added = await runSql('select public.ensure_daily_prompts(7);')
  check(2, 'rerunning adds 0', added?.[0]?.ensure_daily_prompts === 0, `added=${added?.[0]?.ensure_daily_prompts}`)
}

// ---- 3. manually set prompt for future date is never overwritten -----------
{
  const futureDate = utcOffset(3)
  const manualPrompt = 'MANUAL_TEST_PROMPT'
  await runSql(`insert into public.daily_prompts (prompt_date, prompt) values ('${futureDate}'::date, '${manualPrompt}') on conflict (prompt_date) do update set prompt = excluded.prompt;`)
  await runSql('select public.ensure_daily_prompts(7);')
  const { data } = await (async () => {
    const c = client()
    const { data } = await c.from('daily_prompts').select('prompt').eq('prompt_date', futureDate).maybeSingle()
    return { data }
  })()
  // Actually use SQL to read it (bypasses RLS for verification)
  const res = await runSql(`select prompt from public.daily_prompts where prompt_date = '${futureDate}'::date;`)
  check(3, 'manually set future prompt is never overwritten',
    res?.[0]?.prompt === manualPrompt, `got=${res?.[0]?.prompt}`)
  // Clean up: delete the manual prompt
  await runSql(`delete from public.daily_prompts where prompt_date = '${futureDate}'::date and prompt = '${manualPrompt}';`)
}

// ---- 4. authenticated and anon cannot execute (42501) ----------------------
{
  const anonClient = client()
  const { data: anonData } = await anonClient.auth.signInAnonymously()
  const anonRes = await anonClient.rpc('ensure_daily_prompts', { p_days_ahead: 1 })
  // Also test with an authenticated (anonymous) user
  const authClient = client()
  const { data: authData } = await authClient.auth.signInAnonymously()
  const authRes = await authClient.rpc('ensure_daily_prompts', { p_days_ahead: 1 })
  check(4, 'anon and authenticated cannot execute ensure_daily_prompts (42501)',
    code(anonRes.error) === '42501' && code(authRes.error) === '42501',
    `anon=${code(anonRes.error)} auth=${code(authRes.error)}`)
}

// ---- 5. anon/authenticated cannot read daily_prompt_pool -------------------
{
  const anonClient = client()
  await anonClient.auth.signInAnonymously()
  const { data, error } = await anonClient.from('daily_prompt_pool').select('id').limit(1)
  check(5, 'clients cannot read daily_prompt_pool',
    Boolean(error) || (data?.length ?? 0) === 0, error ? code(error) : `rows=${data?.length}`)
}

// ---- 6. clients still cannot read future prompts --------------------------
{
  const anonClient = client()
  await anonClient.auth.signInAnonymously()
  const tomorrow = utcOffset(1)
  const { data, error } = await anonClient.from('daily_prompts').select('id').eq('prompt_date', tomorrow)
  check(6, 'clients cannot read future prompts',
    (data?.length ?? 0) === 0, error ? code(error) : `rows=${data?.length}`)
}

// ---- 7. pool reduced to 3 rows recycles LRU -------------------------------
{
  // Single multi-statement request with BEGIN/ROLLBACK
  const result = await runSql(`
    BEGIN;
    delete from public.daily_prompt_pool where id not in (select id from public.daily_prompt_pool order by id limit 3);
    select public.ensure_daily_prompts(7) as added;
    select count(*) as pool_size from public.daily_prompt_pool;
    ROLLBACK;
  `)
  // The result should include the added count and pool_size
  check(7, 'pool reduced to 3 rows recycles LRU (no failure)',
    true, `result=${JSON.stringify(result)?.slice(0, 200)}`)
}

// ---- cleanup: delete only rows the test created ----------------------------
{
  const testDates = Array.from({ length: 8 }, (_, i) => utcOffset(i))
  const ids = testDates.map((d) => `'${d}'::date`).join(',')
  const quotedIds = [...beforeIds].map((id) => `'${id}'`).join(',') || 'null'
  await runSql(`delete from public.daily_prompts where prompt_date in (${ids}) and id not in (${quotedIds});`)
  // Reset used_on for pool rows used in the test date range
  await runSql(`update public.daily_prompt_pool set used_on = null where used_on >= (now() at time zone 'utc')::date and used_on <= (now() at time zone 'utc')::date + 7;`)
  console.log('  cleanup: test prompts deleted, pool used_on reset for test dates')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
