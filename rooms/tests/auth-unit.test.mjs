// Unit tests: token verification against a local JWKS, Turnstile with a
// mocked siteverify, IP-cap helpers, and production-config hygiene.
// No network beyond the local JWKS server.
//
//   node tests/auth-unit.test.mjs
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { verifyAccessToken } from '../src/auth.js'
import { verifyTurnstile } from '../src/turnstile.js'
import { ipCapAllows, maxIpSockets, MAX_ROOMS_PER_USER_PER_HOUR, maxRoomsPerIpPerHour } from '../src/config.js'
import { buildJoinHeaders } from '../src/forward.js'
import { clientIpHash, hashKey, ipHashSaltOk } from '../src/hash.js'
import { check, summary } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---- verifyAccessToken against a local JWKS -------------------------------
const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
const jwk = await exportJWK(publicKey)
const jwks = { keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] }
const server = http.createServer((req, res) => {
  if (req.url === '/auth/v1/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(jwks))
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const env = { SUPABASE_URL: `http://127.0.0.1:${server.address().port}` }

async function sign(exp, { aud = 'authenticated', iss = `${env.SUPABASE_URL}/auth/v1`, sub = 'user-1' } = {}) {
  return new SignJWT({ sub, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(exp)
    .sign(privateKey)
}

const now = Math.floor(Date.now() / 1000)
check('expired token rejected', (await verifyAccessToken(await sign(now - 60), env)) === null)
const fresh = await verifyAccessToken(await sign(now + 3600), env)
check('fresh token accepted', fresh?.sub === 'user-1')
check('wrong audience rejected', (await verifyAccessToken(await sign(now + 3600, { aud: 'someone-else' }), env)) === null)
check('wrong issuer rejected', (await verifyAccessToken(await sign(now + 3600, { iss: 'https://evil.example/auth/v1' }), env)) === null)
check('null token rejected', (await verifyAccessToken(null, env)) === null)
check('empty token rejected', (await verifyAccessToken('', env)) === null)
server.close()

// ---- Turnstile with mocked siteverify -------------------------------------
const mockFetch = (impl) => async (url, init) => impl(url, init)
const goodSiteverify = mockFetch(async () => ({ ok: true, json: async () => ({ success: true }) }))
const badSiteverify = mockFetch(async () => ({ ok: true, json: async () => ({ success: false }) }))
const downSiteverify = mockFetch(async () => { throw new Error('network down') })
const http500 = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }))

check('turnstile: valid token accepted', await verifyTurnstile('tok', 'secret', goodSiteverify))
check('turnstile: rejected token refused', (await verifyTurnstile('tok', 'secret', badSiteverify)) === false)
check('turnstile: unreachable siteverify refused', (await verifyTurnstile('tok', 'secret', downSiteverify)) === false)
check('turnstile: siteverify 500 refused', (await verifyTurnstile('tok', 'secret', http500)) === false)
check('turnstile: missing token refused', (await verifyTurnstile(undefined, 'secret', goodSiteverify)) === false)
check('turnstile: empty token refused', (await verifyTurnstile('', 'secret', goodSiteverify)) === false)

// ---- IP socket cap helpers ------------------------------------------------
check('default IP socket cap is 4', maxIpSockets({}) === 4)
check('dev override accepted', maxIpSockets({ IP_ROOM_SOCKET_LIMIT: '8' }) === 8)
check('bogus override falls back to 4', maxIpSockets({ IP_ROOM_SOCKET_LIMIT: '99' }) === 4)
check('negative override falls back to 4', maxIpSockets({ IP_ROOM_SOCKET_LIMIT: '-1' }) === 4)
const fourSame = [{ ipHash: 'a' }, { ipHash: 'a' }, { ipHash: 'a' }, { ipHash: 'a' }]
check('5th socket from one IP rejected at default', ipCapAllows(fourSame, 'a', 4) === false)
check('5th socket allowed when limit is 8', ipCapAllows(fourSame, 'a', 8) === true)
check('other IPs unaffected', ipCapAllows(fourSame, 'b', 4) === true)
check('no hash: cap cannot be enforced (allowed)', ipCapAllows(fourSame, null, 4) === true)

// ---- Worker -> DO header allowlist -----------------------------------------
const hostile = new Headers({
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGVzdGtleQ==',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Extensions': 'permessage-deflate',
  'Sec-WebSocket-Protocol': 'dabble.v1, eyJhbGciOi.fake.sig',
  'X-Action': 'create',
  'X-User': 'attacker',
  'X-User-Name': 'EVIL',
  'X-User-Country': 'XX',
  'X-IP-Hash': 'forged-hash',
  'X-Test-IP': '198.18.7.7',
  'X-Protocol': 'evil.v9',
  Authorization: 'Bearer eyJhbGciOi.fake.sig',
  Cookie: 'session=1',
})
const fwdNoSalt = buildJoinHeaders(hostile, { userId: 'user-1', name: 'Guest', country: null, ipHash: null })
check('allowlist keeps Upgrade', fwdNoSalt.get('Upgrade') === 'websocket')
check('allowlist keeps Sec-WebSocket-Key', fwdNoSalt.get('Sec-WebSocket-Key') === 'dGVzdGtleQ==')
check('client X-Action dropped', fwdNoSalt.get('X-Action') === null)
check('client X-User replaced with the trusted one', fwdNoSalt.get('X-User') === 'user-1')
check('client X-User-Name replaced', fwdNoSalt.get('X-User-Name') === 'Guest')
check('client X-User-Country replaced', fwdNoSalt.get('X-User-Country') === '')
check('client X-IP-Hash dropped when no salt', fwdNoSalt.get('X-IP-Hash') === null)
check('client X-Test-IP never forwarded to the DO', fwdNoSalt.get('X-Test-IP') === null)
check('client X-Protocol replaced', fwdNoSalt.get('X-Protocol') === 'dabble.v1')
check('Sec-WebSocket-Protocol never forwarded (JWT carrier)', fwdNoSalt.get('Sec-WebSocket-Protocol') === null)
check('Authorization never forwarded', fwdNoSalt.get('Authorization') === null)
check('Cookie never forwarded', fwdNoSalt.get('Cookie') === null)
const fwdSalted = buildJoinHeaders(hostile, { userId: 'user-1', name: 'Guest', country: 'NZ', ipHash: 'abc123' })
check('trusted X-IP-Hash forwarded when computed', fwdSalted.get('X-IP-Hash') === 'abc123')
check('trusted country forwarded', fwdSalted.get('X-User-Country') === 'NZ')

// ---- Production fail-closed without a usable IP hash salt ------------------
check('prod without salt -> fail closed', ipHashSaltOk({ ENVIRONMENT: 'production' }) === false)
check('prod short salt (<16) -> fail closed', ipHashSaltOk({ ENVIRONMENT: 'production', IP_HASH_SALT: 'x'.repeat(15) }) === false)
check('prod 16-char salt -> ok', ipHashSaltOk({ ENVIRONMENT: 'production', IP_HASH_SALT: 'x'.repeat(16) }) === true)
check('prod long salt -> ok', ipHashSaltOk({ ENVIRONMENT: 'production', IP_HASH_SALT: 'x'.repeat(64) }) === true)
check('dev without salt -> lenient', ipHashSaltOk({ ENVIRONMENT: 'dev' }) === true)
check('ENVIRONMENT unset -> lenient', ipHashSaltOk({}) === true)

// ---- dev-only X-Test-IP override (test isolation) --------------------------
// One fixed salt so the module-level HMAC key cache stays consistent.
const TEST_SALT = 's'.repeat(32)
const reqWith = (testIp, realIp) =>
  new Request('https://rooms/ws', {
    headers: {
      ...(testIp !== undefined ? { 'X-Test-IP': testIp } : {}),
      ...(realIp ? { 'CF-Connecting-IP': realIp } : {}),
    },
  })
const REAL_IP = '203.0.113.9'
const realHash = await hashKey(TEST_SALT, REAL_IP)
const overrideHash = await hashKey(TEST_SALT, '198.18.7.7')
check(
  'dev honors X-Test-IP (hashed with the same salt)',
  (await clientIpHash(reqWith('198.18.7.7', REAL_IP), { ENVIRONMENT: 'dev', IP_HASH_SALT: TEST_SALT })) === overrideHash
)
for (const envVal of [undefined, 'Dev', 'development', 'staging', 'production']) {
  check(
    `X-Test-IP ignored when ENVIRONMENT=${String(envVal)}`,
    (await clientIpHash(reqWith('198.18.7.7', REAL_IP), { ENVIRONMENT: envVal, IP_HASH_SALT: TEST_SALT })) === realHash
  )
}
check(
  'dev falls back to CF-Connecting-IP with no X-Test-IP',
  (await clientIpHash(reqWith(undefined, REAL_IP), { ENVIRONMENT: 'dev', IP_HASH_SALT: TEST_SALT })) === realHash
)
check(
  'dev rejects a bad-charset X-Test-IP',
  (await clientIpHash(reqWith('not a valid ip !', REAL_IP), { ENVIRONMENT: 'dev', IP_HASH_SALT: TEST_SALT })) === realHash
)
check(
  'dev rejects an over-long X-Test-IP',
  (await clientIpHash(reqWith('1'.repeat(46), REAL_IP), { ENVIRONMENT: 'dev', IP_HASH_SALT: TEST_SALT })) === realHash
)
check(
  'dev accepts an IPv6 X-Test-IP',
  (await clientIpHash(reqWith('2001:db8::1', REAL_IP), { ENVIRONMENT: 'dev', IP_HASH_SALT: TEST_SALT })) ===
    (await hashKey(TEST_SALT, '2001:db8::1'))
)
check(
  'without a salt X-Test-IP still yields null',
  (await clientIpHash(reqWith('198.18.7.7', REAL_IP), { ENVIRONMENT: 'dev' })) === null
)

// ---- Room creation budgets -------------------------------------------------
check('per-IP creation default is 30', maxRoomsPerIpPerHour({}) === 30)
check('per-IP creation dev override accepted', maxRoomsPerIpPerHour({ MAX_ROOMS_PER_IP_PER_HOUR: '100' }) === 100)
check('bogus per-IP creation override falls back to 30', maxRoomsPerIpPerHour({ MAX_ROOMS_PER_IP_PER_HOUR: 'bogus' }) === 30)
check('per-user creation stays 5', MAX_ROOMS_PER_USER_PER_HOUR === 5)

// ---- Production config hygiene --------------------------------------------
// The production env must not define test knobs or real values.
const toml = readFileSync(path.join(here, '..', 'wrangler.toml'), 'utf8')
const prodIdx = toml.indexOf('[env.production]')
check('wrangler.toml defines [env.production]', prodIdx > 0)
const prodSection = toml.slice(prodIdx)
for (const forbidden of ['SIMULATE_QUOTA', 'IP_ROOM_SOCKET_LIMIT', 'MAX_ROOMS_PER_IP_PER_HOUR', 'ROOM_GRACE_MS', 'SEAT_HOLD_MS', 'VITE_']) {
  check(`production env does not define ${forbidden}`, !prodSection.includes(forbidden))
}
check('production SUPABASE_URL is a placeholder', prodSection.includes('PRODUCTION_SUPABASE_URL'))
check('production origin is a placeholder', prodSection.includes('PRODUCTION_APP_ORIGIN.example'))
check('production worker is named dabble-rooms', /name = "dabble-rooms"/.test(prodSection))

summary('auth-unit')
