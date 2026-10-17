// Phase 4.1 unit tests for the session endpoints (api/_lib.js).
// No network: a tiny in-memory PostgREST/Supabase stand-in records writes so we
// can assert ordering (players before sessions) and heartbeat throttling.
//
// Run: node tests/api.test.mjs
import {
  HEARTBEAT_WRITE_MIN_INTERVAL_MS,
  parseCountry,
  processRequest,
} from '../api/_lib.js'

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

const USER = { id: '11111111-1111-4111-8111-111111111111' }
const OTHER = '22222222-2222-4222-8222-222222222222'

function pick(row, cols) {
  if (!cols) return row
  const out = {}
  for (const c of cols.split(',').map((s) => s.trim())) out[c] = row[c]
  return out
}

function builder(db, table) {
  const q = { table, method: null, values: null, filters: [], cols: null, order: null, limit: null, ignore: false }

  function exec() {
    const rows = db[table]
    const match = () => rows.filter((r) => q.filters.every(([c, v]) => r[c] === v))
    if (q.method === 'select') {
      let out = match()
      if (q.order) {
        const { col, ascending } = q.order
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending === false ? -1 : 1))
      }
      if (q.limit) out = out.slice(0, q.limit)
      return { data: out.map((r) => pick(r, q.cols)), error: null }
    }
    if (q.method === 'insert') {
      const list = (Array.isArray(q.values) ? q.values : [q.values]).map((v) => ({
        id: v.id ?? `fake-${++db.seq}`,
        ...v,
      }))
      rows.push(...list)
      db.writes.push({ table, op: 'insert' })
      return { data: list.map((r) => pick(r, q.cols)), error: null }
    }
    if (q.method === 'upsert') {
      for (const v of Array.isArray(q.values) ? q.values : [q.values]) {
        const found = rows.find((r) => r.id === v.id)
        if (!found) {
          rows.push({ ...v })
          db.writes.push({ table, op: 'upsert-insert' })
        } else if (!q.ignore) {
          Object.assign(found, v)
          db.writes.push({ table, op: 'upsert-update' })
        }
      }
      return { error: null }
    }
    if (q.method === 'update') {
      const hits = match()
      for (const r of hits) Object.assign(r, q.values)
      db.writes.push({ table, op: 'update', count: hits.length })
      return { error: null }
    }
    return { error: null }
  }

  function one() {
    const res = exec()
    const data = Array.isArray(res.data) ? res.data[0] ?? null : res.data ?? null
    return { data, error: res.error }
  }

  const api = {
    select(cols) { if (!q.method) q.method = 'select'; q.cols = cols; return api },
    insert(values) { q.method = 'insert'; q.values = values; return api },
    update(values) { q.method = 'update'; q.values = values; return api },
    upsert(values, opts) { q.method = 'upsert'; q.values = values; q.ignore = Boolean(opts?.ignoreDuplicates); return api },
    eq(col, val) { q.filters.push([col, val]); return api },
    order(col, opts) { q.order = { col, ascending: opts?.ascending }; return api },
    limit(n) { q.limit = n; return api },
    maybeSingle() { return Promise.resolve(one()) },
    single() { return Promise.resolve(one()) },
    then(resolve, reject) { return Promise.resolve(exec()).then(resolve, reject) },
  }
  return api
}

const makeDb = (seed = {}) => ({
  players: (seed.players ?? []).map((p) => ({ ...p })),
  sessions: (seed.sessions ?? []).map((s) => ({ ...s })),
  writes: [],
  seq: 0,
})

function makeClient(db, token = 'valid') {
  return {
    auth: {
      getUser: async (t) =>
        t === token ? { data: { user: USER }, error: null } : { data: { user: null }, error: new Error('bad token') },
    },
    from: (table) => builder(db, table),
  }
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res },
    json(body) { res.body = body; return res },
  }
  return res
}

async function wire(db, req, kind) {
  const res = makeRes()
  await processRequest(req, res, { supabase: makeClient(db), kind })
  return res
}

const post = (over = {}) => ({ method: 'POST', headers: { authorization: 'Bearer valid' }, body: {}, ...over })
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// ---- country parsing (pure) ---------------------------------------------
{
  const cases = [
    [{ 'x-vercel-ip-country': 'de' }, 'DE'],
    [{ 'cf-ipcountry': 'br' }, 'BR'],
    [{ 'x-vercel-ip-country': 'XYZ' }, null],
    [{ 'x-vercel-ip-country': '12' }, null],
    [{ 'x-vercel-ip-country': 'XX' }, null],
    [{ 'x-vercel-ip-country': 'T1' }, null],
    [{}, null],
  ]
  const wrong = cases.filter(([headers, expect]) => parseCountry(headers) !== expect)
  check('country', 'country is validated from the geo header only; absent/malformed -> null',
    wrong.length === 0, JSON.stringify(wrong))
}

// ---- method / auth -------------------------------------------------------
{
  const r = await wire(makeDb(), { method: 'GET', headers: {} }, 'session')
  check('method', 'non-POST is rejected with 405 before any auth work',
    r.statusCode === 405 && r.body.error === 'method_not_allowed', `status=${r.statusCode}`)
}
{
  const r1 = await wire(makeDb(), { method: 'POST', headers: {} }, 'session')
  const r2 = await wire(makeDb(), post({ headers: { authorization: 'Bearer nope' } }), 'session')
  check('auth', 'missing or invalid token is 401', r1.statusCode === 401 && r2.statusCode === 401,
    `missing=${r1.statusCode} bad=${r2.statusCode}`)
}

// ---- session creation ----------------------------------------------------
{
  const db = makeDb()
  const headers = { authorization: 'Bearer valid', 'x-vercel-ip-country': 'fr', 'x-forwarded-for': '203.0.113.9' }
  const r = await wire(db, post({ headers }), 'session')
  const order = db.writes.map((w) => `${w.table}:${w.op}`)
  const session = db.sessions[0]
  const player = db.players.find((p) => p.id === USER.id)
  const leakedIp = JSON.stringify(r.body).includes('203.0.113.9')
  check('session-new', 'new session: players upserted before the sessions insert, with the country',
    r.statusCode === 200 && order.indexOf('players:upsert-insert') < order.indexOf('sessions:insert') &&
      session?.country_code === 'FR' && session?.user_id === USER.id && r.body.session_id === session.id,
    `order=${order.join(',')} row=${JSON.stringify(session)} id=${r.body.session_id}`)
  check('session-no-ip', 'no IP is read, stored or echoed', !leakedIp && !JSON.stringify(db.sessions).includes('203.0.113.9'),
    `body=${JSON.stringify(r.body)}`)
  check('session-lastcountry', "players.last_country follows the visitor's country",
    player?.last_country === 'FR', `last_country=${player?.last_country}`)
}
{
  const db = makeDb()
  const r = await wire(db, post(), 'session')
  check('session-nocountry', 'no geo header (local dev): session stored with a null country',
    r.statusCode === 200 && db.sessions[0]?.country_code === null && r.body.country === null,
    `row=${JSON.stringify(db.sessions[0])}`)
}

// ---- session reuse / staleness ------------------------------------------
{
  const db = makeDb({
    players: [{ id: USER.id }],
    sessions: [{ id: 's-recent', user_id: USER.id, country_code: 'DE', last_seen: ago(60_000) }],
  })
  const r = await wire(db, post({ headers: { authorization: 'Bearer valid', 'x-vercel-ip-country': 'DE' } }), 'session')
  check('session-reuse', 'a session seen within the window is reused (no insert)',
    r.body.session_id === 's-recent' && db.sessions.length === 1 && !db.writes.some((w) => w.op === 'insert'),
    `id=${r.body.session_id} rows=${db.sessions.length}`)
}
{
  const db = makeDb({
    players: [{ id: USER.id }],
    sessions: [{ id: 's-old', user_id: USER.id, country_code: 'DE', last_seen: ago(10 * 60_000) }],
  })
  const r = await wire(db, post(), 'session')
  check('session-stale', 'a forgotten session is not reused; a fresh one is created',
    r.body.session_id !== 's-old' && db.sessions.length === 2 && r.body.country === null,
    `id=${r.body.session_id} rows=${db.sessions.length}`)
}

// ---- heartbeat ----------------------------------------------------------
{
  const db = makeDb({ players: [{ id: USER.id }], sessions: [{ id: 's-me', user_id: USER.id, last_seen: ago(3_000) }] })
  const r = await wire(db, post({ body: { session_id: 's-me' } }), 'heartbeat')
  check('heartbeat-throttled', 'last_seen under the write interval: same id, no write',
    r.body.session_id === 's-me' && !db.writes.some((w) => w.op === 'update'),
    `id=${r.body.session_id} writes=${JSON.stringify(db.writes)}`)
}
{
  const db = makeDb({
    players: [{ id: USER.id }],
    sessions: [{ id: 's-me', user_id: USER.id, last_seen: ago(HEARTBEAT_WRITE_MIN_INTERVAL_MS + 5_000) }],
  })
  const before = db.sessions[0].last_seen
  const r = await wire(db, post({ body: { session_id: 's-me' } }), 'heartbeat')
  const after = db.sessions[0].last_seen
  check('heartbeat-write', 'an older own session is touched (last_seen moves forward)',
    r.body.session_id === 's-me' && after !== before && db.sessions.length === 1,
    `id=${r.body.session_id} before=${before} after=${after}`)
}
{
  const db = makeDb({ players: [{ id: USER.id }], sessions: [{ id: 's-other', user_id: OTHER, last_seen: ago(60_000) }] })
  const before = db.sessions[0].last_seen
  const r = await wire(db, post({ body: { session_id: 's-other' } }), 'heartbeat')
  const other = db.sessions.find((s) => s.id === 's-other')
  check('heartbeat-foreign', "another user's session id is ignored (untouched, new session created)",
    r.body.session_id !== 's-other' && other.last_seen === before && db.sessions.length === 2,
    `id=${r.body.session_id} rows=${db.sessions.length}`)
}
{
  // sendBeacon path: no Authorization header, token in the body.
  const db = makeDb({ players: [{ id: USER.id }], sessions: [{ id: 's-beacon', user_id: USER.id, last_seen: ago(60_000) }] })
  const r = await wire(db, { method: 'POST', headers: {}, body: { session_id: 's-beacon', access_token: 'valid' } }, 'heartbeat')
  check('heartbeat-beacon', 'token from the body (sendBeacon) authenticates',
    r.statusCode === 200 && r.body.session_id === 's-beacon', `status=${r.statusCode} body=${JSON.stringify(r.body)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
