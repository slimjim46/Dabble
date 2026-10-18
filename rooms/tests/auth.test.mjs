// Live auth tests against the dev worker (dev Supabase).
//
//   ROOMS_ALLOWED_URL must exactly match the target worker.
//   node tests/auth.test.mjs
import { SignJWT, generateKeyPair } from 'jose'
import WebSocket from 'ws'
import { anonUser, check, connect, createRoom, probeWs, summary, SUPABASE_URL, TARGET } from './helpers.mjs'

// ---- POST /rooms auth -----------------------------------------------------
{
  const noAuth = await fetch(`${TARGET}/rooms`, { method: 'POST' })
  check('POST /rooms without token -> 401', noAuth.status === 401)

  const { token } = await anonUser()
  const parts = token.split('.')
  const tampered = parts[0] + '.' + parts[1] + '.' + parts[2].split('').reverse().join('')
  const r = await createRoom(tampered)
  check('POST /rooms tampered token -> 401', r.status === 401)

  const good = await createRoom(token)
  check('POST /rooms valid token -> 201', good.status === 201)
  check('POST /rooms returns a 5-char code', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(good.body?.code || ''))

  const evil = await createRoom(token, {}, { Origin: 'https://evil.example' })
  check('POST /rooms disallowed Origin -> 403', evil.status === 403)

  // Turnstile is disabled on dev (no secret): a junk captcha field is
  // ignored, proving the check is skipped without a secret.
  const junkCaptcha = await createRoom(token, { turn: 'not-a-real-token' })
  check('POST /rooms skips Turnstile when no secret is set', junkCaptcha.status === 201)
}

// ---- CORS -----------------------------------------------------------------
{
  const { token } = await anonUser()
  const res = await fetch(`${TARGET}/rooms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Origin: 'http://localhost:5173' },
    body: '{}',
  })
  const acao = res.headers.get('access-control-allow-origin')
  check('POST /rooms allowed Origin echoes CORS', res.status === 201 && acao === 'http://localhost:5173')
  await res.json()

  const pre = await fetch(`${TARGET}/rooms`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  })
  check(
    'OPTIONS preflight -> 204 with CORS',
    pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'http://localhost:5173'
  )

  const preEvil = await fetch(`${TARGET}/rooms`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  })
  check('OPTIONS preflight disallowed Origin -> 403', preEvil.status === 403)
}

// ---- WS token transport (header only) -------------------------------------
{
  const { token } = await anonUser()
  const creator = await createRoom(token)
  const code = creator.body.code

  const noProto = await probeWs(code, [])
  check('WS without protocol header -> 400', noProto.status === 400)

  const wrongProto = await probeWs(code, ['nope', token])
  check('WS wrong first protocol -> 400', wrongProto.status === 400)

  const noToken = await probeWs(code, ['dabble.v1'])
  check('WS dabble.v1 without token -> 401', noToken.status === 401)

  const garbage = await probeWs(code, ['dabble.v1', 'not.a.jwt'])
  check('WS garbage token -> 401', garbage.status === 401)

  const parts = token.split('.')
  const tampered = parts[0] + '.' + parts[1] + '.' + parts[2].split('').reverse().join('')
  const tamp = await probeWs(code, ['dabble.v1', tampered])
  check('WS tampered token -> 401', tamp.status === 401)

  const { privateKey } = await generateKeyPair('ES256', { extractable: true })
  const forged = await new SignJWT({ sub: 'attacker', role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'fake' })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
  const forgedRes = await probeWs(code, ['dabble.v1', forged])
  check('WS forged-key token -> 401', forgedRes.status === 401)

  // No query-string token path: a query token without the protocol header
  // is never read (still 400), and when the header carries the token the
  // query is ignored (connects fine).
  const queryOnly = await new Promise((resolve) => {
    const ws = new WebSocket(`${TARGET}/ws?room=${code}&token=${token}`)
    const timer = setTimeout(() => resolve({ status: 'timeout' }), 10000)
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer)
      res.resume()
      resolve({ status: res.statusCode })
    })
    ws.on('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve({ status: 101 })
    })
    ws.on('error', () => {})
  })
  check('WS query-token without protocol header -> 400 (no query path)', queryOnly.status === 400)

  const c = await connect(code, token)
  check('WS header token connects with protocol echo', c.status === undefined && c.protocol === 'dabble.v1')
  if (c.ws) await c.close()
}

// ---- Banned users ---------------------------------------------------------
{
  const { supabase, token } = await anonUser()
  const banned = await supabase.rpc('dev_only_set_banned', { p_banned: true })
  check('dev helper dev_only_set_banned works', !banned.error, banned.error?.message || '')

  const post = await createRoom(token)
  check('POST /rooms banned user -> 403', post.status === 403 && post.body?.error === 'banned')

  const other = await anonUser()
  const { body } = await createRoom(other.token)
  const join = await probeWs(body.code, ['dabble.v1', token])
  check('WS join banned user -> 403', join.status === 403 && JSON.parse(join.body || '{}')?.error === 'banned')

  const unbanned = await supabase.rpc('dev_only_set_banned', { p_banned: false })
  check('test player unbanned at the end', !unbanned.error, unbanned.error?.message || '')
  const postOk = await createRoom(token)
  check('POST /rooms works again after unban', postOk.status === 201)
}

// ---- Unknown room / bad code ---------------------------------------------
{
  const { token } = await anonUser()
  const unknown = await probeWs('QQQQQ', ['dabble.v1', token])
  check('WS unknown-but-valid code -> 404', unknown.status === 404)

  const bad1 = await probeWs('ABC', ['dabble.v1', token])
  check('WS short code -> 400 (before auth)', bad1.status === 400)
  const bad2 = await probeWs('IIIII', ['dabble.v1', token])
  check('WS look-alike chars -> 400', bad2.status === 400)
  const bad3 = await probeWs('ABCDEF', ['dabble.v1', token])
  check('WS 6-char code -> 400', bad3.status === 400)
}

summary('auth')
