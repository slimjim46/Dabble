// Limiter DO: hourly room-creation budgets (5/user/h, 10/hashed-IP/h).
// One global instance; tiny state; an hourly alarm prunes stale buckets.
//
// Why a DO and not the Workers rate limiting binding: that binding only
// supports 10 s or 60 s periods (developers.cloudflare.com/workers/
// runtime-apis/bindings/rate-limit), so it cannot express an hourly window.
// Short-window join limits DO use the binding; this is creation only.
import { logEvent } from './log.js'

const HOUR_MS = 3600000

export class Limiter {
  constructor(state) {
    this.state = state
  }

  windowStart(now = Date.now()) {
    return Math.floor(now / HOUR_MS) * HOUR_MS
  }

  async fetch(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const checks = Array.isArray(body?.checks) ? body.checks : null
    if (!checks || checks.length === 0 || checks.length > 4) {
      return new Response('bad request', { status: 400 })
    }
    for (const c of checks) {
      if (typeof c?.key !== 'string' || c.key.length === 0 || c.key.length > 128) return new Response('bad request', { status: 400 })
      if (!Number.isInteger(c?.limit) || c.limit < 1 || c.limit > 10000) return new Response('bad request', { status: 400 })
    }

    const now = Date.now()
    const win = this.windowStart(now)
    const stored = (await this.state.storage.get(checks.map((c) => c.key))) || {}

    for (const c of checks) {
      const cur = stored[c.key]
      const count = cur && cur.w === win ? cur.n : 0
      if (count >= c.limit) {
        logEvent('create_rate_limited', { key: c.key.startsWith('u:') ? 'user' : 'ip' })
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': String(Math.ceil((win + HOUR_MS - now) / 1000)) },
        })
      }
    }

    const updates = {}
    for (const c of checks) {
      const cur = stored[c.key]
      updates[c.key] = { w: win, n: cur && cur.w === win ? cur.n + 1 : 1 }
    }
    await this.state.storage.put(updates)

    // Prune old buckets once an hour at most.
    if (!(await this.state.storage.getAlarm())) {
      try {
        await this.state.storage.setAlarm(win + HOUR_MS)
      } catch {}
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  async alarm() {
    const win = this.windowStart()
    const stale = []
    for await (const [key, val] of this.state.storage.list()) {
      if (val?.w !== win) stale.push(key)
    }
    if (stale.length) await this.state.storage.delete(stale)
    // Re-arm only while buckets exist; a fresh reserve() arms it again.
    const remaining = await this.state.storage.list()
    if (remaining.size > 0) {
      try {
        await this.state.storage.setAlarm(win + HOUR_MS)
      } catch {}
    }
  }
}
