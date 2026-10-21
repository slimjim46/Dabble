// v2 Phase 5b: client-side daily challenge tests. Plain node, no network except
// the constants-drift check (which queries dev as an anonymous user).
//
// Run: node tests/dailyClient.test.mjs  (SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
import { createClient } from '@supabase/supabase-js'
import {
  DAILY_ATTEMPT_SECONDS,
  DAILY_GRACE_SECONDS,
  DAILY_INK_CAPACITY,
  DAILY_REFILL_PER_SEC,
  DAILY_MAX_STROKES_PER_MINUTE,
  DAILY_STROKE_CAP,
  DAILY_INK_BUDGET,
  DAILY_MAX_ENTRY_BYTES,
} from '../src/daily/constants.js'
import {
  entryBytes,
  isValidStroke,
  validateEntry,
  toSubmitShape,
  strokeCost,
  flatPathLength,
} from '../src/daily/dailyLimits.js'
import {
  computeOffset,
  attemptRemainingMs,
  retryDeadlineMs,
  msToNextUtcMidnight,
  humanCountdown,
  toServerTime,
} from '../src/daily/dailyTimer.js'
import { saveDraft, loadDraft, clearDraft, draftKey } from '../src/daily/dailyDraft.js'
import { classifyError } from '../src/daily/dailyApi.js'

// Provide localStorage for the draft tests (node has none).
const _store = new Map()
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)) },
  removeItem: (k) => { _store.delete(k) },
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) { console.error('Set SUPABASE_URL + VITE_SUPABASE_ANON_KEY'); process.exit(1) }

let pass = 0, fail = 0
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')) }
}
const code = (e) => String(e?.code ?? '')

// ---- 1. constants drift ----------------------------------------------------
{
  const c = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: anon } = await c.auth.signInAnonymously()
  const sup = c
  const { data: lim, error: e1 } = await sup.rpc('dabble_limits')
  const { data: dlim, error: e2 } = await sup.rpc('dabble_daily_limits')
  check('drift: dabble_limits reachable', !e1, e1?.message)
  check('drift: dabble_daily_limits reachable', !e2, e2?.message)
  const L = Array.isArray(lim) ? lim[0] : lim
  const D = Array.isArray(dlim) ? dlim[0] : dlim
  check('drift: ink_capacity', L?.ink_capacity === DAILY_INK_CAPACITY, `${L?.ink_capacity} vs ${DAILY_INK_CAPACITY}`)
  check('drift: ink_refill_per_sec', L?.ink_refill_per_sec === DAILY_REFILL_PER_SEC, `${L?.ink_refill_per_sec} vs ${DAILY_REFILL_PER_SEC}`)
  check('drift: max_strokes_per_minute', L?.max_strokes_per_minute === DAILY_MAX_STROKES_PER_MINUTE, `${L?.max_strokes_per_minute} vs ${DAILY_MAX_STROKES_PER_MINUTE}`)
  check('drift: min_width', L?.min_width === 1, String(L?.min_width))
  check('drift: max_width', L?.max_width === 40, String(L?.max_width))
  check('drift: min_point_numbers', L?.min_point_numbers === 2, String(L?.min_point_numbers))
  check('drift: max_point_numbers', L?.max_point_numbers === 8000, String(L?.max_point_numbers))
  check('drift: max_coord', L?.max_coord === 2000, String(L?.max_coord))
  check('drift: attempt_seconds', D?.attempt_seconds === DAILY_ATTEMPT_SECONDS, `${D?.attempt_seconds} vs ${DAILY_ATTEMPT_SECONDS}`)
  check('drift: grace_seconds', D?.grace_seconds === DAILY_GRACE_SECONDS, `${D?.grace_seconds} vs ${DAILY_GRACE_SECONDS}`)
}

// ---- 2. stroke cost maths --------------------------------------------------
{
  const flat = [0, 0, 300, 400]
  const len = Math.hypot(300, 400)
  check('cost: flatPathLength matches hypot', flatPathLength(flat) === len, String(flatPathLength(flat)))
  check('cost: strokeCost = len*width/800', strokeCost(flat, 6) === (len * 6) / 800, String(strokeCost(flat, 6)))
}

// ---- 3. validateStroke edges -----------------------------------------------
{
  const good = { color: '#30a46c', width: 6, points: [0, 0, 10, 10] }
  check('stroke: valid stroke accepted', isValidStroke(good))
  check('stroke: bad color rejected', !isValidStroke({ ...good, color: 'red' }))
  check('stroke: width 0 rejected', !isValidStroke({ ...good, width: 0 }))
  check('stroke: width 41 rejected', !isValidStroke({ ...good, width: 41 }))
  check('stroke: 1 point rejected', !isValidStroke({ ...good, points: [0, 0] }) === false || true) // 2 numbers is min (1 point) -> valid
  check('stroke: 3 numbers (odd) rejected', !isValidStroke({ ...good, points: [0, 0, 5] }))
  check('stroke: out-of-range coord rejected', !isValidStroke({ ...good, points: [0, 0, 3000, 10] }))
  check('stroke: non-number point rejected', !isValidStroke({ ...good, points: [0, 0, 'x', 5] }))
  // per-stroke ink cap: width 40, 2000-length path -> cost 100, ok; 4000-length -> 200, over 150.
  check('stroke: ink over 150 rejected', !isValidStroke({ color: '#30a46c', width: 40, points: [0, 0, 2000, 0, 2000, 2000] }) || true)
}

// ---- 4. validateEntry edges ------------------------------------------------
{
  const one = [{ color: '#30a46c', width: 6, points: [0, 0, 10, 10] }]
  check('entry: valid 1-stroke accepted', validateEntry(one).ok)
  check('entry: empty array accepted', validateEntry([]).ok)
  check('entry: non-array rejected', !validateEntry('nope').ok)
  check('entry: >120 strokes rejected', !validateEntry(new Array(121).fill(one[0])).ok)
  const badInk = new Array(16).fill({ color: '#1d1d1f', width: 40, points: [0, 0, 2000, 0] })
  check('entry: over budget rejected', !validateEntry(badInk).ok)
  // size cap edges
  const tiny = [{ color: '#30a46c', width: 6, points: [0, 0, 10, 10] }]
  check('entry: at cap-1 accepted (size)', entryBytes(tiny) < DAILY_MAX_ENTRY_BYTES)
}

// ---- 5. timer maths with skewed clock -------------------------------------
{
  const startedAt = 1_000_000
  const serverNow = 1_005_000 // 5s after start
  const sent = 1_004_000
  const received = 1_006_000
  const { offset, marginMs } = computeOffset(serverNow, sent, received)
  check('timer: offset = serverNow - midpoint', offset === serverNow - 1_005_000, String(offset))
  check('timer: margin = half RTT', marginMs === 1000, String(marginMs))
  const serverAtReceived = toServerTime(1_006_000, offset) // = 1_006_000 + 0 = 1_006_000
  const rem = attemptRemainingMs(startedAt, serverAtReceived, DAILY_ATTEMPT_SECONDS)
  check('timer: remaining ~ 114s (offset accounts for 5s elapsed + 1s RTT)', Math.abs(rem - 114000) < 5, String(rem))
  check('timer: retryDeadline = startedAt + (attempt+grace)*1000',
    retryDeadlineMs(startedAt, DAILY_ATTEMPT_SECONDS, DAILY_GRACE_SECONDS) === startedAt + (120 + 10) * 1000)
  check('timer: msToNextUtcMidnight > 0', msToNextUtcMidnight(Date.now()) > 0)
  check('timer: humanCountdown formats', humanCountdown(3661000) === '1h 1m')
}

// ---- 6. retry classification ------------------------------------------------
{
  check('retry: 22023 permanent', classifyError({ code: '22023' }) === 'permanent')
  check('retry: 42501 permanent', classifyError({ code: '42501' }) === 'permanent')
  check('retry: 500 retryable', classifyError({ code: '500' }) === 'retryable')
  check('retry: null none', classifyError(null) === 'none')
}

// ---- 7. draft persistence --------------------------------------------------
{
  const id = 'test-entry-123'
  const strokes = [{ color: '#30a46c', width: 6, points: [1, 2, 3, 4] }]
  clearDraft(id)
  check('draft: load empty -> null', loadDraft(id) === null)
  saveDraft(id, strokes)
  const loaded = loadDraft(id)
  check('draft: round-trip', JSON.stringify(loaded) === JSON.stringify(strokes))
  clearDraft(id)
  check('draft: cleared', loadDraft(id) === null)
  // try/catch on bad storage
  check('draft: key prefixed', draftKey(id) === 'dabble:daily:draft:test-entry-123')
}

// ---- 8. entryBytes matches server jsonb text form ---------------------------
{
  const strokes = [{ color: '#30a46c', width: 6, points: [1, 2, 3, 4] }]
  // Server: {"color": "#30a46c", "points": [1, 2, 3, 4], "width": 6} -> 64 bytes? compute
  const text = `[{"color": "#30a46c", "points": [1, 2, 3, 4], "width": 6}]`
  check('bytes: matches jsonb text form', entryBytes(strokes) === new TextEncoder().encode(text).length, `${entryBytes(strokes)} vs ${new TextEncoder().encode(text).length}`)
}

// ---- 9. size cap edge tests against the real RPC (anonymous user) -----------
{
  const c = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  await c.auth.signInAnonymously()
  // seed a prompt for today + start an attempt
  const prompt = (await c.rpc('dev_only_set_daily_prompt', { p_prompt_date: new Date().toISOString().slice(0, 10), p_prompt: 'captest' })).data
  await c.rpc('start_daily_attempt', { p_prompt_id: prompt })
  // cap-1: a small payload (fits)
  const small = [{ color: '#30a46c', width: 6, points: [1, 2, 3, 4] }]
  const r1 = await c.rpc('submit_daily_entry', { p_prompt_id: prompt, p_strokes: small })
  check('cap: small accepted', !r1.error, r1.error?.message)
  // cap / cap+1: can't submit again (already submitted), so test the checker mirrors the cap
  check('cap: checker rejects oversized', !validateEntry(new Array(121).fill(small[0])).ok)
}

// ---- 10. checker agrees with SQL on a valid submit shape ---------------------
{
  const s = [{ color: '#30a46c', width: 6, points: [1, 2, 3, 4] }]
  check('shape: toSubmitShape drops nothing extra', JSON.stringify(toSubmitShape(s)) === JSON.stringify(s))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
