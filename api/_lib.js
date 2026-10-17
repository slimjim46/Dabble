// Shared logic for the Phase 4 session endpoints.
//
// Lives in api/_lib.js on purpose: Vercel never turns `_`-prefixed files in
// api/ into functions, so this module is bundled into both endpoints but is
// not itself routable.
//
// Everything here is a pure function over a Supabase client (the service-role
// client is created lazily in makeHandler) so the handlers can be unit-tested
// with a mocked client. Nothing logs headers, tokens or IPs — ever.
import { createClient } from '@supabase/supabase-js'

export const SESSION_REUSE_WINDOW_MS = 5 * 60 * 1000
// Heartbeat writes are throttled in the database, not in memory: serverless
// instances share no memory, but they all see the session's last_seen.
export const HEARTBEAT_WRITE_MIN_INTERVAL_MS = 10 * 1000

const COUNTRY_RE = /^[A-Z]{2}$/

/**
 * Country from the platform header. Absent or malformed -> null (also the
 * normal case in local dev, where no header exists).
 */
export function parseCountry(headers) {
  const raw = headers?.['x-vercel-ip-country'] ?? headers?.['cf-ipcountry']
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  if (!COUNTRY_RE.test(code) || code === 'XX' || code === 'T1') return null
  return code
}

/**
 * Access token from `Authorization: Bearer <token>` or `body.access_token`
 * (sendBeacon cannot set headers on pagehide).
 */
export function extractToken(req) {
  const header = req?.headers?.authorization
  if (typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (match) return match[1].trim()
  }
  const body = req?.body
  if (body && typeof body === 'object' && typeof body.access_token === 'string') {
    return body.access_token
  }
  return null
}

/** Body as an object, tolerating an unparsed string payload. */
function readBody(req) {
  if (req?.body && typeof req.body === 'object') return req.body
  if (typeof req?.body === 'string' && req.body.length < 10000) {
    try {
      const parsed = JSON.parse(req.body)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** The players row must exist before sessions can reference it. */
async function ensurePlayer(supabase, userId) {
  const { error } = await supabase
    .from('players')
    .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true })
  return error ?? null
}

async function insertSession(supabase, userId, country = null, now = Date.now()) {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ user_id: userId, country_code: country, login_time: new Date(now).toISOString(),
      last_seen: new Date(now).toISOString() })
    .select('id')
    .single()
  if (error || !data) return { status: 500, body: { error: 'session_insert_failed' } }
  return { status: 200, body: { session_id: data.id, country } }
}

/**
 * POST /api/session — called once on page load, after anonymous sign-in.
 * Reuses the newest session if it was seen in the last 5 minutes.
 */
export async function sessionHandler(supabase, { userId, country, now = Date.now() }) {
  const playersError = await ensurePlayer(supabase, userId)
  if (playersError) return { status: 500, body: { error: 'players_upsert_failed' } }

  if (country) {
    await supabase.from('players').update({ last_country: country }).eq('id', userId)
  }

  const { data: latest } = await supabase
    .from('sessions')
    .select('id, last_seen')
    .eq('user_id', userId)
    .order('last_seen', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latest && Date.parse(latest.last_seen) > now - SESSION_REUSE_WINDOW_MS) {
    await supabase
      .from('sessions')
      .update({ last_seen: new Date(now).toISOString() })
      .eq('id', latest.id)
    return { status: 200, body: { session_id: latest.id, country } }
  }

  return insertSession(supabase, userId, country, now)
}

/**
 * POST /api/heartbeat — body { session_id }.
 * The session must belong to the caller; anyone else's id is ignored (a new
 * session is created instead). If the row was touched under 10 seconds ago
 * the call returns without a write.
 */
export async function heartbeatHandler(supabase, { userId, sessionId, now = Date.now() }) {
  if (typeof sessionId === 'string' && sessionId) {
    const { data: found } = await supabase
      .from('sessions')
      .select('id, last_seen')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (found) {
      const last = Date.parse(found.last_seen)
      if (last > now - SESSION_REUSE_WINDOW_MS) {
        if (now - last >= HEARTBEAT_WRITE_MIN_INTERVAL_MS) {
          await supabase
            .from('sessions')
            .update({ last_seen: new Date(now).toISOString() })
            .eq('id', found.id)
        }
        return { status: 200, body: { session_id: found.id } }
      }
    }
  }

  // Missing, someone else's, or stale: start a fresh session.
  const playersError = await ensurePlayer(supabase, userId)
  if (playersError) return { status: 500, body: { error: 'players_upsert_failed' } }
  return insertSession(supabase, userId)
}

/**
 * The whole request pipeline, with the client injected: method check, token
 * verification, then the handler for `kind` ('session' or 'heartbeat').
 */
export async function processRequest(req, res, { supabase, kind }) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const token = extractToken(req)
  let user = null
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token)
      if (!error && data?.user) user = data.user
    } catch {
      user = null
    }
  }
  if (!user) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const body = readBody(req)
  const result =
    kind === 'session'
      ? await sessionHandler(supabase, { userId: user.id, country: parseCountry(req.headers) })
      : await heartbeatHandler(supabase, {
        userId: user.id,
        sessionId: typeof body.session_id === 'string' ? body.session_id : null,
      })

  res.status(result.status).json(result.body)
}

/** Vercel function wrapper: creates the service-role client per invocation. */
export function makeHandler(kind) {
  return async function handler(req, res) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      res.status(500).json({ error: 'not_configured' })
      return
    }
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    await processRequest(req, res, { supabase, kind })
  }
}
