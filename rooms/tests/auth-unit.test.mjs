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
import { ipCapAllows, maxIpSockets } from '../src/config.js'
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
