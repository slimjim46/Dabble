// Dabble v2 room server (Worker side).
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
import { CREATE_CODE_ATTEMPTS, MAX_NAME_LENGTH, MAX_ROOMS_PER_IP_PER_HOUR, MAX_ROOMS_PER_USER_PER_HOUR } from './config.js'
import { clientIpHash } from './hash.js'
import { fetchIdentity } from './identity.js'
import { Limiter } from './limiter.js'
import { logEvent } from './log.js'
import { Room } from './room.js'
import { verifyTurnstile } from './turnstile.js'

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
    'access-control-allow-methods': 'POST, OPTIONS',
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
  if (ipHash) checks.push({ key: `i:${ipHash}`, limit: MAX_ROOMS_PER_IP_PER_HOUR })
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
        headers: { 'X-Action': 'create', 'X-User': claims.sub },
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
  //    the protocol header is deleted, any query token is dropped unread,
  //    and only trusted fields are set.
  url.searchParams.delete('token') // never read, only scrubbed
  const fwd = new Request(url.toString(), request)
  const headers = new Headers(fwd.headers)
  headers.delete('Sec-WebSocket-Protocol')
  headers.set('X-Protocol', 'dabble.v1')
  headers.set('X-User', claims.sub)
  headers.set('X-User-Name', encodeURIComponent(identity.name.slice(0, MAX_NAME_LENGTH)))
  headers.set('X-User-Country', identity.country || '')
  if (ipHash) headers.set('X-IP-Hash', ipHash)

  const hasTokenLike = [...headers.values()].some((v) => /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(v)) ||
    url.searchParams.has('token')
  if (hasTokenLike) {
    // Should be unreachable: prove it loudly if it ever isn't.
    logEvent('jwt_leak_guard')
    return json(500, { error: 'internal' })
  }

  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return await stub.fetch(new Request(fwd, { headers }))
  } catch (e) {
    logEvent('do_fetch_error', { route: 'join', err: errName(e) })
    return roomsBusy('join')
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

    if (url.pathname === '/ws') {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' })
      return joinRoom(request, env, url)
    }

    return json(404, { error: 'not_found' })
  },
}
