// Unit tests for the busy path, fully offline: the real Worker fetch handler
// is driven with a mock env whose ROOM binding rejects with a quota-style
// error, plus the dev-only SIMULATE_QUOTA knob.
//
//   ROOMS_ALLOWED_URL must be set (helpers guard, same as auth-unit).
//   node tests/busy-unit.test.mjs
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import worker from '../src/index.js'
import { check, summary } from './helpers.mjs'

// ---- Local Supabase stand-in: JWKS + players REST -------------------------
const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
const jwk = await exportJWK(publicKey)
const jwks = { keys: [{ ...jwk, kid: 'busy-key', alg: 'ES256', use: 'sig' }] }

let playersAppear = true
let playerBanned = false
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/auth/v1/.well-known/jwks.json')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(jwks))
    return
  }
  if (req.url.startsWith('/rest/v1/players')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (!playersAppear) res.end('[]')
    else res.end(JSON.stringify([{ name: 'Tester', last_country: 'NZ', banned: playerBanned }]))
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const SUPABASE_URL = `http://127.0.0.1:${server.address().port}`

async function sign(sub = 'user-busy') {
  return new SignJWT({ sub, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'busy-key' })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey)
}
const token = await sign()

// ---- Env with a controllable ROOM binding ---------------------------------
function makeEnv(overrides = {}) {
  const calls = { room: 0 }
  const ROOM = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => {
        calls.room++
        if (overrides.roomMode === 'throw') throw new Error('quota exceeded (simulated)')
        return new Response('created', { status: 201 })
      },
    }),
  }
  const LIMITER = {
    idFromName: () => 'global',
    get: () => ({ fetch: async () => ({ ok: true, status: 200 }) }),
  }
  const env = {
    ENVIRONMENT: 'dev',
    IP_HASH_SALT: 'a'.repeat(24),
    SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon-test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ROOM,
    LIMITER,
    JOIN_USER: { limit: async () => ({ success: true }) },
    JOIN_IP: { limit: async () => ({ success: true }) },
    ...overrides.env,
  }
  return { env, calls }
}

function postRooms(tok = token) {
  return new Request('https://worker.test/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: '{}',
  })
}
function joinWs(room = 'ABCDE', tok = token) {
  return new Request(`https://worker.test/ws?room=${room}`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `dabble.v1, ${tok}`,
      'CF-Connecting-IP': '203.0.113.9',
    },
  })
}
const bodyOf = async (res) => {
  const t = await res.text()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

// ---- Preconditions: the harness reaches the right branches ----------------
{
  const { env } = makeEnv()
  const res = await worker.fetch(postRooms(), env)
  check('mock-env sanity: create succeeds when the DO does (201)', res.status === 201, `status ${res.status}`)
  check('mock-env sanity: room code returned', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test((await bodyOf(res)).code))
}

// ---- ROOM binding rejects (quota-style) -> 503 rooms_busy -----------------
{
  const { env } = makeEnv({ roomMode: 'throw' })
  const res = await worker.fetch(postRooms(), env)
  const body = await bodyOf(res)
  check('create: DO fetch failure -> 503', res.status === 503, `status ${res.status}`)
  check('create: body is rooms_busy', body?.error === 'rooms_busy', JSON.stringify(body))
  check('create: Retry-After present', res.headers.get('retry-after') === '30', res.headers.get('retry-after'))
}
{
  const { env } = makeEnv({ roomMode: 'throw' })
  const res = await worker.fetch(joinWs(), env)
  const body = await bodyOf(res)
  check('join: DO fetch failure -> 503', res.status === 503, `status ${res.status}`)
  check('join: body is rooms_busy', body?.error === 'rooms_busy', JSON.stringify(body))
  check('join: Retry-After present', res.headers.get('retry-after') === '30', res.headers.get('retry-after'))
}

// ---- SIMULATE_QUOTA=1 in dev short-circuits BEFORE any DO call ------------
{
  const { env, calls } = makeEnv({ env: { ENVIRONMENT: 'dev', SIMULATE_QUOTA: '1' } })
  const res = await worker.fetch(postRooms(), env)
  check('dev SIMULATE_QUOTA: create -> 503 rooms_busy', res.status === 503 && (await bodyOf(res))?.error === 'rooms_busy')
  check('dev SIMULATE_QUOTA: ROOM never called (create)', calls.room === 0, `calls ${calls.room}`)

  const { env: env2, calls: calls2 } = makeEnv({ env: { ENVIRONMENT: 'dev', SIMULATE_QUOTA: '1' } })
  const res2 = await worker.fetch(joinWs(), env2)
  check('dev SIMULATE_QUOTA: join -> 503 rooms_busy', res2.status === 503 && (await bodyOf(res2))?.error === 'rooms_busy')
  check('dev SIMULATE_QUOTA: ROOM never called (join)', calls2.room === 0, `calls ${calls2.room}`)
}

// ---- SIMULATE_QUOTA ignored when ENVIRONMENT !== 'dev' --------------------
{
  const { env } = makeEnv({ env: { ENVIRONMENT: 'production', SIMULATE_QUOTA: '1' } })
  const res = await worker.fetch(postRooms(), env)
  check('prod + SIMULATE_QUOTA: create NOT busy (201)', res.status === 201, `status ${res.status}`)
}
{
  const { env, calls } = makeEnv({ env: { ENVIRONMENT: 'production', SIMULATE_QUOTA: '1' } })
  const res = await worker.fetch(joinWs(), env)
  // Production is fail-closed on missing salt, but the salt IS present here,
  // so the join passes the gate and reaches the mocked DO (201 'created').
  check('prod + SIMULATE_QUOTA: join reaches the DO', res.status === 201, `status ${res.status}`)
  check('prod + SIMULATE_QUOTA: ROOM called (join)', calls.room === 1, `calls ${calls.room}`)
}
{
  const { env } = makeEnv({ env: { ENVIRONMENT: undefined, SIMULATE_QUOTA: '1' } })
  const res = await worker.fetch(postRooms(), env)
  check('ENVIRONMENT unset + SIMULATE_QUOTA: create NOT busy (201)', res.status === 201, `status ${res.status}`)
}

// ---- Production fail-closed without a usable salt ------------------------
{
  const { env, calls } = makeEnv({ env: { ENVIRONMENT: 'production', IP_HASH_SALT: undefined } })
  const res = await worker.fetch(postRooms(), env)
  check('prod, no salt: create -> 503 rooms_busy (fail closed)', res.status === 503 && (await bodyOf(res))?.error === 'rooms_busy')
  check('prod, no salt: ROOM never called', calls.room === 0, `calls ${calls.room}`)
}
{
  const { env } = makeEnv({ env: { ENVIRONMENT: 'production', IP_HASH_SALT: 'short' } })
  const res = await worker.fetch(joinWs(), env)
  check('prod, short salt: join -> 503 rooms_busy (fail closed)', res.status === 503 && (await bodyOf(res))?.error === 'rooms_busy')
}

// ---- A missing players row / banned user still behaves (identity sanity) --
// Fresh user ids throughout: identity.js caches non-banned rows for 60 s, so
// reusing the main token here would mask both cases.
{
  playersAppear = false
  const fresh = await sign('user-no-row')
  const { env } = makeEnv()
  const res = await worker.fetch(postRooms(fresh), env)
  check('missing players row: create still succeeds (Guest)', res.status === 201, `status ${res.status}`)
  playersAppear = true

  playerBanned = true
  const banned = await sign('user-banned')
  const { env: env2 } = makeEnv()
  const res2 = await worker.fetch(joinWs('ABCDE', banned), env2)
  check('banned user: join -> 403 before the DO', res2.status === 403 && (await bodyOf(res2))?.error === 'banned')
  playerBanned = false
}

server.close()
summary('busy-unit')
