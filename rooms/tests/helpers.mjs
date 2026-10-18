// Shared test helpers for the rooms server suites.
//
// Safety rails: the target URL must be pinned with ROOMS_ALLOWED_URL (like
// the spike) so a suite can never be pointed at the wrong worker, and the
// Supabase env comes from the repo-root .env (dev project only). No value
// that could be a key or token is ever printed.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))

function loadRootEnv() {
  const out = {}
  for (const line of readFileSync(path.join(here, '..', '..', '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}
const rootEnv = loadRootEnv()

export const TARGET = process.env.ROOMS_TARGET_URL || 'https://dabble-rooms-dev.rowan-dev-workers.workers.dev'
const ALLOWED = process.env.ROOMS_ALLOWED_URL
if (!ALLOWED || TARGET !== ALLOWED) {
  console.error(`refusing to run: set ROOMS_ALLOWED_URL to exactly ${TARGET}`)
  process.exit(1)
}

const SUPABASE_URL = process.env.SUPABASE_URL || rootEnv.VITE_SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY || rootEnv.VITE_SUPABASE_ANON_KEY
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('refusing to run: dev SUPABASE_URL and SUPABASE_ANON_KEY required')
  process.exit(1)
}
export { SUPABASE_URL, ANON_KEY }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
export function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}
export function summary(suite) {
  console.log(`--- ${suite}: ${pass} passed, ${fail} failed`)
  // Always exit explicitly: supabase-js clients keep the event loop alive.
  process.exit(fail > 0 ? 1 : 0)
}

/** Fresh anonymous user against the dev project. @returns {token, userId} */
export async function anonUser() {
  const supabase = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error || !data?.session?.access_token) throw new Error(`anon sign-in failed: ${error?.message}`)
  return { supabase, token: data.session.access_token, userId: data.user.id }
}

export async function createRoom(token, extra = {}, headerExtra = {}) {
  const res = await fetch(`${TARGET}/rooms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headerExtra },
    body: JSON.stringify(extra),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, headers: res.headers }
}

export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/

/**
 * Open a socket or capture the HTTP rejection.
 * @returns {status: 101, ws} or {status, body}
 */
export function probeWs(room, protocols = [], headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${TARGET}/ws?room=${room}`, protocols, { headers })
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try { ws.terminate() } catch {}
        reject(new Error('probe timeout'))
      }
    }, 12000)
    ws.on('open', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ status: 101, ws })
    })
    ws.on('unexpected-response', (req, res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      res.resume()
    })
    ws.on('error', () => {}) // surfaces via unexpected-response or close
  })
}

/**
 * Connect with a valid token; resolves with a message queue + waiters.
 * If the server accepts then immediately closes (kick block), the caller
 * sees `closed` populated and no `welcome`.
 */
export async function connect(room, token, { headers = {}, waitForWelcome = true } = {}) {
  const r = await probeWs(room, ['dabble.v1', token], headers)
  if (r.status !== 101) return r
  const c = {
    ws: r.ws,
    protocol: r.ws.protocol,
    messages: [],
    closes: [],
    closed: false,
  }
  r.ws.on('message', (d) => c.messages.push(d.toString()))
  r.ws.on('close', (code, reason) => {
    c.closed = true
    c.closes.push({ code, reason: reason.toString() })
  })
  c.json = () => c.messages.map((m) => { try { return JSON.parse(m) } catch { return null } }).filter(Boolean)
  c.waitFor = (pred, ms = 8000) =>
    new Promise((resolve) => {
      const start = Date.now()
      const iv = setInterval(() => {
        const hit = c.json().find((m) => pred(m))
        if (hit || c.closed || Date.now() - start > ms) {
          clearInterval(iv)
          resolve(hit || null)
        }
      }, 20)
    })
  c.waitForClose = (code, ms = 8000) =>
    new Promise((resolve) => {
      const start = Date.now()
      const iv = setInterval(() => {
        const hit = c.closes.find((x) => x.code === code)
        if (hit || Date.now() - start > ms) {
          clearInterval(iv)
          resolve(hit || null)
        }
      }, 20)
    })
  c.close = () =>
    new Promise((resolve) => {
      if (c.closed) return resolve()
      r.ws.once('close', () => resolve())
      try { r.ws.close() } catch { resolve() }
    })
  if (waitForWelcome) {
    c.welcome = await c.waitFor((m) => m.t === 'welcome')
  }
  return c
}
