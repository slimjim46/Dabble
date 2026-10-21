// DoodleScrap v2 room server (Worker side).
//
// Routes:
//   POST /rooms   authenticated room creation -> {code}
//   GET  /ws      WebSocket join (Sec-WebSocket-Protocol: dabble.v1, <jwt>)
//
// Rules: validate the room code format BEFORE touching a Durable Object,
// pass join attempts through the rate limiting bindings first, never let a
// JWT cross into a DO, never trust client-supplied identity, and map DO
// failures (including an exhausted daily quota) to 503 rooms_busy so the
// client can show a friendly screen.
import { verifyAccessToken } from './auth.js'
import { isValidCode, randomCode } from './codes.js'
import { CREATE_CODE_ATTEMPTS, MAX_ROOMS_PER_USER_PER_HOUR, maxRoomsPerIpPerHour } from './config.js'
import { wordAllowed } from './filter.js'
import { buildJoinHeaders } from './forward.js'
import { clientIpHash, ipHashSaltOk } from './hash.js'
import { fetchIdentity } from './identity.js'
import { Limiter } from './limiter.js'
import { logEvent } from './log.js'
import { Room } from './room.js'
import { verifyTurnstile } from './turnstile.js'
import { sanitizeCustomWords } from './words.js'

export { Limiter, Room }

const JSON_HEADERS = { 'content-type': 'application/json' }

function originList(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Browsers always send Origin on WebSocket/POST; non-browser clients (tests,
// curl) send none and are allowed. A present Origin must match exactly.
function checkOrigin(request, env) {
  const origin = request.headers.get('Origin')
  if (!origin) return { ok: true, origin: null }
  return { ok: originList(env).includes(origin), origin }
}

function corsHeaders(origin, allowed) {
  if (!origin || !allowed) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

function json(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extraHeaders } })
}

function roomsBusy(route) {
  logEvent('rooms_busy', { route })
  return json(503, { error: 'rooms_busy' }, { 'retry-after': '30' })
}

function errName(e) {
  return String(e?.name || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32)
}

// Test double for the daily-quota failure path. Honored only in the dev
// environment: the production config defines ENVIRONMENT=production and
// never defines SIMULATE_QUOTA, and this checks both.
function quotaSimulated(env) {
  return env.ENVIRONMENT === 'dev' && env.SIMULATE_QUOTA === '1'
}

async function rateLimitJoin(env, userId, ipHash) {
  if (env.JOIN_USER) {
    const { success } = await env.JOIN_USER.limit({ key: userId })
    if (!success) return false
  } else {
    logEvent('ratelimit_missing', { binding: 'join_user' })
  }
  if (ipHash) {
    if (env.JOIN_IP) {
      const { success } = await env.JOIN_IP.limit({ key: ipHash })
      if (!success) return false
    } else {
      logEvent('ratelimit_missing', { binding: 'join_ip' })
    }
  }
  return true
}

async function reserveRoomCreation(env, userId, ipHash) {
  const checks = [{ key: `u:${userId}`, limit: MAX_ROOMS_PER_USER_PER_HOUR }]
  if (ipHash) checks.push({ key: `i:${ipHash}`, limit: maxRoomsPerIpPerHour(env) })
  try {
    const stub = env.LIMITER.get(env.LIMITER.idFromName('global'))
    const res = await stub.fetch('https://limiter/', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ checks }),
    })
    if (res.status === 429) return { limited: true, response: res }
    if (!res.ok) throw new Error(`limiter_${res.status}`)
    return { limited: false }
  } catch (e) {
    // Fail closed on limiter trouble: an unknown state must not allow
    // unbounded creation.
    logEvent('limiter_error', { err: errName(e) })
    return { limited: true, response: json(503, { error: 'rooms_busy' }, { 'retry-after': '60' }) }
  }
}

async function readBearer(request) {
  const auth = request.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) return null
  return auth.slice(7).trim() || null
}

async function createRoom(request, env) {
  // Production without a usable IP hash salt means every per-IP limit is
  // unenforceable: refuse to serve instead of serving unprotected.
  if (!ipHashSaltOk(env)) {
    logEvent('prod_salt_missing', { route: 'create' })
    return roomsBusy('create')
  }

  const origin = checkOrigin(request, env)
  const cors = corsHeaders(origin.origin, origin.ok)
  if (!origin.ok) {
    logEvent('origin_rejected', { route: 'create' })
    return json(403, { error: 'origin' }, cors)
  }

  const token = await readBearer(request)
  const claims = token ? await verifyAccessToken(token, env) : null
  if (!claims || typeof claims.sub !== 'string') {
    logEvent('create_unauth')
    return json(401, { error: 'unauthorized' }, cors)
  }

  let body = null
  try {
    body = await request.json()
  } catch {}

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(body?.turn, env.TURNSTILE_SECRET)
    if (!ok) {
      logEvent('captcha_reject', { route: 'create' })
      return json(403, { error: 'captcha' }, cors)
    }
  }

  const identity = await fetchIdentity(claims.sub, token, env)
  if (identity.banned) {
    logEvent('banned_reject', { route: 'create' })
    return json(403, { error: 'banned' }, cors)
  }

  const ipHash = await clientIpHash(request, env)
  const reserve = await reserveRoomCreation(env, claims.sub, ipHash)
  if (reserve.limited) {
    const res = reserve.response
    const bodyText = await res.text()
    return new Response(bodyText, {
      status: res.status,
      headers: { ...JSON_HEADERS, ...cors, ...(res.headers.get('retry-after') ? { 'retry-after': res.headers.get('retry-after') } : {}) },
    })
  }

  if (quotaSimulated(env)) return roomsBusy('create')

  for (let attempt = 1; attempt <= CREATE_CODE_ATTEMPTS; attempt++) {
    const code = randomCode()
    const stub = env.ROOM.get(env.ROOM.idFromName(code))
    let res
    try {
      res = await stub.fetch('https://room/create', {
        method: 'POST',
        headers: { 'X-User': claims.sub },
      })
    } catch (e) {
      // Daily quota exhausted (or any DO call failure): friendly 503.
      logEvent('do_fetch_error', { route: 'create', err: errName(e) })
      return roomsBusy('create')
    }
    if (res.status === 201) {
      logEvent('room_create', { attempt })
      return json(201, { code }, cors)
    }
    if (res.status === 409) continue // collision: retry with a fresh code
    logEvent('create_unexpected', { status: res.status })
    return roomsBusy('create')
  }
  // 10 collisions in a 28.6M space: effectively impossible, retry-friendly.
  logEvent('create_collision_exhausted')
  return roomsBusy('create')
}

async function joinRoom(request, env, url) {
  // Fail closed before anything else spends a DO or binding: production
  // without a usable IP hash salt cannot enforce the per-IP caps.
  if (!ipHashSaltOk(env)) {
    logEvent('prod_salt_missing', { route: 'join' })
    return roomsBusy('join')
  }

  // 1. Code format BEFORE any Durable Object is touched: junk probes can
  //    never spend a DO invocation.
  const room = (url.searchParams.get('room') || '').toUpperCase()
  if (!isValidCode(room)) {
    logEvent('probe_bad_format')
    return json(400, { error: 'bad_room_code' })
  }

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json(426, { error: 'websocket_upgrade_required' })
  }

  // 2. Header-only token transport. No query-string token path exists.
  const swp = request.headers.get('Sec-WebSocket-Protocol') || ''
  const parts = swp.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts[0] !== 'dabble.v1') {
    logEvent('join_bad_protocol')
    return json(400, { error: 'unsupported_protocol' })
  }
  const token = parts[1] || null
  const claims = token ? await verifyAccessToken(token, env) : null
  if (!claims || typeof claims.sub !== 'string') {
    logEvent('join_unauth')
    return json(401, { error: 'unauthorized' })
  }

  const origin = checkOrigin(request, env)
  if (!origin.ok) {
    logEvent('origin_rejected', { route: 'join' })
    return json(403, { error: 'origin' })
  }

  // 3. Rate limiting bindings: caps how fast one actor can spend DO quota
  //    on valid-code or random-code joins.
  const ipHash = await clientIpHash(request, env)
  const allowed = await rateLimitJoin(env, claims.sub, ipHash)
  if (!allowed) {
    logEvent('join_rate_limited')
    return json(429, { error: 'rate_limited' }, { 'retry-after': '60' })
  }

  // 4. Server-authoritative identity: banned users are rejected before the
  //    DO is touched.
  const identity = await fetchIdentity(claims.sub, token, env)
  if (identity.banned) {
    logEvent('banned_reject', { route: 'join' })
    return json(403, { error: 'banned' })
  }

  if (quotaSimulated(env)) return roomsBusy('join')

  // 5. Forward the upgrade to the Room DO. The JWT never crosses this line:
  //    the request is rebuilt from the allowlist in forward.js, so client
  //    X-* headers (X-Action, X-IP-Hash, X-User*) never reach the DO and
  //    Sec-WebSocket-Protocol (the token carrier) is never copied.
  url.searchParams.delete('token') // never read, only scrubbed
  const headers = buildJoinHeaders(request.headers, {
    userId: claims.sub,
    name: identity.name,
    country: identity.country,
    ipHash,
  })

  const hasTokenLike = [...headers.values()].some((v) => /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(v)) ||
    url.searchParams.has('token')
  if (hasTokenLike) {
    // Should be unreachable: prove it loudly if it ever isn't.
    logEvent('jwt_leak_guard')
    return json(500, { error: 'internal' })
  }

  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return await stub.fetch(new Request(url.toString(), { method: 'GET', headers }))
  } catch (e) {
    logEvent('do_fetch_error', { route: 'join', err: errName(e) })
    return roomsBusy('join')
  }
}

/**
 * GET /rooms/<CODE>/status — the pre-join probe.
 *
 * A browser WebSocket cannot read the HTTP status of a failed handshake, so
 * 429 room_full, 404 unknown room and 503 rooms_busy would be invisible to the
 * room client. This route answers the same questions with a plain response.
 * It runs the same gate order and rules as joinRoom (minus the
 * upgrade-specific steps) so the probe predicts the join instead of
 * disagreeing with it — and it still counts against the join rate limits,
 * because it touches a Durable Object. Two deliberate differences:
 * origin is checked before the token so that *every* error carries CORS
 * headers (a browser can only read the status if it does), and the code
 * comes from the path rather than ?room=.
 * The response body carries only a player count and a full flag: names, ids
 * and countries belong to the welcome message after a successful upgrade.
 */
async function roomStatus(request, env, url) {
  if (!ipHashSaltOk(env)) {
    logEvent('prod_salt_missing', { route: 'status' })
    return roomsBusy('status')
  }

  // /rooms/<CODE>/status — read the code out of the path segments. joinRoom
  // gets it from ?room=, so there is no shared helper to reuse. Raw, not
  // decodeURIComponent: a malformed escape would throw a URIError instead of
  // returning 400, and room codes never need percent-decoding.
  const parts = url.pathname.split('/')
  const code = (parts[2] || '').toUpperCase()
  if (parts.length !== 4 || parts[3] !== 'status' || !isValidCode(code)) {
    logEvent('probe_bad_format')
    return json(400, { error: 'bad_room_code' })
  }

  const origin = checkOrigin(request, env)
  const cors = corsHeaders(origin.origin, origin.ok)
  if (!origin.ok) {
    logEvent('origin_rejected', { route: 'status' })
    return json(403, { error: 'origin' }, cors)
  }

  const token = await readBearer(request)
  const claims = token ? await verifyAccessToken(token, env) : null
  if (!claims || typeof claims.sub !== 'string') {
    logEvent('status_unauth')
    return json(401, { error: 'unauthorized' }, cors)
  }

  const ipHash = await clientIpHash(request, env)
  const allowed = await rateLimitJoin(env, claims.sub, ipHash)
  if (!allowed) {
    logEvent('join_rate_limited')
    return json(429, { error: 'rate_limited' }, { ...cors, 'retry-after': '60' })
  }

  const identity = await fetchIdentity(claims.sub, token, env)
  if (identity.banned) {
    logEvent('banned_reject', { route: 'status' })
    return json(403, { error: 'banned' }, cors)
  }

  if (quotaSimulated(env)) return roomsBusy('status')

  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(code))
    const res = await stub.fetch('https://room/status', {
      method: 'GET',
      headers: ipHash
        ? { 'X-User': claims.sub, 'X-IP-Hash': ipHash }
        : { 'X-User': claims.sub },
    })
    const body = await res.text()
    return new Response(body, { status: res.status, headers: { ...JSON_HEADERS, ...cors } })
  } catch (e) {
    logEvent('do_fetch_error', { route: 'status', err: errName(e) })
    return roomsBusy('status')
  }
}

/**
 * POST /rooms/<CODE>/words — the host sets the room's custom words (v2 Phase
 * 4c). The Worker holds the player's JWT, so the blocked-word filter runs
 * HERE: every word is checked against public.is_word_allowed with the player's
 * own token before the surviving list is forwarded to the DO. The DO never
 * sees a token, and a client-supplied header can never bypass the filter.
 */
async function setRoomWords(request, env, url) {
  if (!ipHashSaltOk(env)) {
    logEvent('prod_salt_missing', { route: 'words' })
    return roomsBusy('words')
  }

  const parts = url.pathname.split('/')
  const code = (parts[2] || '').toUpperCase()
  if (parts.length !== 4 || parts[3] !== 'words' || !isValidCode(code)) {
    logEvent('probe_bad_format', { route: 'words' })
    return json(400, { error: 'bad_room_code' })
  }

  const origin = checkOrigin(request, env)
  const cors = corsHeaders(origin.origin, origin.ok)
  if (!origin.ok) {
    logEvent('origin_rejected', { route: 'words' })
    return json(403, { error: 'origin' }, cors)
  }

  const token = await readBearer(request)
  const claims = token ? await verifyAccessToken(token, env) : null
  if (!claims || typeof claims.sub !== 'string') {
    logEvent('words_unauth')
    return json(401, { error: 'unauthorized' }, cors)
  }

  const ipHash = await clientIpHash(request, env)
  const allowed = await rateLimitJoin(env, claims.sub, ipHash)
  if (!allowed) {
    logEvent('words_rate_limited')
    return json(429, { error: 'rate_limited' }, { ...cors, 'retry-after': '60' })
  }

  const identity = await fetchIdentity(claims.sub, token, env)
  if (identity.banned) {
    logEvent('banned_reject', { route: 'words' })
    return json(403, { error: 'banned' }, cors)
  }

  let body = null
  try {
    body = await request.json()
  } catch {}

  const words = sanitizeCustomWords(body?.words)
  if (!words) {
    logEvent('words_bad_shape')
    return json(400, { error: 'bad_words' }, cors)
  }

  // Filter each word. Fail closed: an unverified word is rejected. No word is
  // ever logged or returned to the client.
  for (const word of words) {
    if (!(await wordAllowed(word, token, env))) {
      logEvent('word_rejected')
      return json(422, { error: 'word_rejected' }, cors)
    }
  }

  if (quotaSimulated(env)) return roomsBusy('words')

  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(code))
    const res = await stub.fetch('https://room/words', {
      method: 'POST',
      headers: { 'X-User': claims.sub },
      body: JSON.stringify({ words }),
    })
    const resBody = await res.text()
    return new Response(resBody, { status: res.status, headers: { ...JSON_HEADERS, ...cors } })
  } catch (e) {
    logEvent('do_fetch_error', { route: 'words', err: errName(e) })
    return roomsBusy('words')
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()

    if (url.pathname === '/rooms') {
      if (method === 'OPTIONS') {
        const origin = checkOrigin(request, env)
        if (!origin.ok) return json(403, { error: 'origin' })
        return new Response(null, { status: 204, headers: corsHeaders(origin.origin, true) })
      }
      if (method === 'POST') return createRoom(request, env)
      return json(405, { error: 'method_not_allowed' })
    }

    if (url.pathname.startsWith('/rooms/')) {
      if (method === 'OPTIONS') {
        const origin = checkOrigin(request, env)
        if (!origin.ok) return json(403, { error: 'origin' })
        return new Response(null, { status: 204, headers: corsHeaders(origin.origin, true) })
      }
      if (method === 'GET') return roomStatus(request, env, url)
      if (method === 'POST') return setRoomWords(request, env, url)
      return json(405, { error: 'method_not_allowed' })
    }

    if (url.pathname === '/ws') {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' })
      return joinRoom(request, env, url)
    }

    return json(404, { error: 'not_found' })
  },
}
