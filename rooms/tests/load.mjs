// Controlled load run against the dev worker. RUN AT MOST ONCE, LAST, and
// only in a UTC window with no other dev usage.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev \
//     LOAD_CONFIRM=yes LOAD_LEDGER=rooms/tests/ledger.jsonl node tests/load.mjs
//
// Shape per room: 1 drawer (stroke @ DRAW_HZ) + (CLIENTS-1) watchers
// (cursor @ CURSOR_HZ). Defaults keep the run under ~300 billed requests.
// Budget:    billed = connections + incomingMessages/20 + alarms
//   - one 10-min 10-player game: 10 + (14 + 9*4)*600/20 = 1510 + alarms.
//
// LOAD_LEDGER appends one metrics-only JSONL row (window start/end in UTC and
// Europe/Amsterdam) for free-tier reconciliation. Never contains tokens, IPs,
// names, or room codes.
//
// Before running, read the Cloudflare dashboards for the "before" numbers:
//   Workers & Pages -> dabble-rooms-dev -> Metrics            (Requests, Errors)
//   Workers & Pages -> Durable Objects -> Room namespace -> Metrics
//                                                             (Requests, Duration)
// Record the displayed time range.
import { appendFileSync } from 'node:fs'
import { anonUser, check, connect, createRoom, summary } from './helpers.mjs'

const ROOMS = Number(process.env.ROOMS || 4)
const CLIENTS = Number(process.env.CLIENTS || 8) // per room, <= dev IP cap 8
const SECONDS = Number(process.env.SECONDS || 30)
const CURSOR_HZ = Number(process.env.CURSOR_HZ || 4)
const DRAW_HZ = Number(process.env.DRAW_HZ || 14)
const MAX_BILLED = 20000

const randKey = () => 'k' + Math.random().toString(36).slice(2, 12)
const uid = () => crypto.randomUUID()

// The Cloudflare dashboards render in the owner's local zone, which is
// Europe/Amsterdam (GMT+2). Record both clocks so a captured window can be
// matched to the dashboard exactly.
const AMS = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Amsterdam',
  dateStyle: 'short',
  timeStyle: 'medium',
})
const amsterdam = (d) => AMS.format(d)

// ---- Projection first: refuse to run if the estimate is too big ----------
const perRoomMsgsPerSec = DRAW_HZ + (CLIENTS - 1) * CURSOR_HZ
const incoming = Math.round(perRoomMsgsPerSec * SECONDS * ROOMS)
const connections = ROOMS * CLIENTS
const alarms = 0 // no seat/hold/lifetime alarm fires inside a short run
const projected = Math.round(connections + incoming / 20 + alarms)
const game10x10 = Math.round(10 + ((DRAW_HZ + 9 * CURSOR_HZ) * 600) / 20)
console.log(
  `projection: ${ROOMS} rooms x ${CLIENTS} clients x ${SECONDS}s ` +
    `=> connections=${connections} incoming=${incoming} projected_billed=${projected} (cap ${MAX_BILLED})`
)
console.log(`projection: ONE 10-min 10-player game => ${game10x10} billed requests`)
if (projected > MAX_BILLED) {
  console.error(`refusing to run: projection ${projected} exceeds ${MAX_BILLED}`)
  process.exit(1)
}
if (process.env.LOAD_CONFIRM !== 'yes') {
  console.error('refusing to run: set LOAD_CONFIRM=yes (run at most once, in a quiet UTC window)')
  process.exit(1)
}

const stats = { sent: 0, recv: 0, errors: 0, unexpected: [], failed: 0 }
const tx = new Map() // "code:k" -> local send time (single process, common clock)
const lat = []
const BAD_CODES = [1008, 1009, 1011, 1012, 1013, 1014]

function instrument(code, c) {
  c.ws.on('message', (d) => {
    stats.recv++
    let m
    try {
      m = JSON.parse(d.toString())
    } catch {
      return
    }
    if (m.t === 'cursor' || m.t === 'stroke_points') {
      const t0 = tx.get(`${code}:${m.k}`)
      if (t0) {
        lat.push(Date.now() - t0)
        tx.delete(`${code}:${m.k}`)
      }
    }
  })
  c.ws.on('close', (code2) => {
    if (BAD_CODES.includes(code2)) stats.unexpected.push(code2)
  })
  c.ws.on('error', () => stats.errors++)
}

function send(code, c, obj) {
  const key = `${code}:${obj.k}`
  tx.set(key, Date.now())
  stats.sent++
  c.ws.send(JSON.stringify(obj))
}

// ---- Build rooms ----------------------------------------------------------
const rooms = []
for (let r = 0; r < ROOMS; r++) {
  const host = await anonUser()
  const { status, body } = await createRoom(host.token)
  if (status !== 201) {
    stats.failed++
    continue
  }
  const code = body.code
  const drawer = await connect(code, host.token)
  if (drawer.status !== 101) {
    stats.failed++
    continue
  }
  instrument(code, drawer)
  const watchers = []
  for (let i = 0; i < CLIENTS - 1; i++) {
    const u = await anonUser()
    const c = await connect(code, u.token)
    if (c.status === 101) {
      instrument(code, c)
      watchers.push(c)
    } else {
      stats.failed++
    }
  }
  rooms.push({ code, drawer, watchers })
}
check('load: all rooms and sockets up', stats.failed === 0 && rooms.length === ROOMS, `${rooms.length}/${ROOMS} rooms, failed=${stats.failed}`)

// ---- Run ------------------------------------------------------------------
const startAt = new Date()
const startISO = startAt.toISOString()
const deadline = Date.now() + SECONDS * 1000
const timers = []
for (const { code, drawer, watchers } of rooms) {
  const id = uid()
  const k = randKey()
  send(code, drawer, { v: 1, t: 'stroke_start', k, id, userId: uid(), userName: 'Load', color: '#0090ff', width: 2, pts: [1, 1] })
  let seq = 0
  timers.push(
    setInterval(() => {
      if (Date.now() > deadline) return
      send(code, drawer, { v: 1, t: 'stroke_points', k, id, seq: ++seq, pts: [seq % 100, (seq * 2) % 100] })
    }, Math.round(1000 / DRAW_HZ))
  )
  for (const w of watchers) {
    timers.push(
      setInterval(() => {
        if (Date.now() > deadline) return
        send(code, w, { v: 1, t: 'cursor', k: randKey(), x: Math.random() * 100, y: Math.random() * 100 })
      }, Math.round(1000 / CURSOR_HZ))
    )
  }
}
console.log(`load window start: ${startISO} (UTC) / ${amsterdam(startAt)} (Europe/Amsterdam)`)
while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
for (const t of timers) clearInterval(t)
const endAt = new Date()
const endISO = endAt.toISOString()

// Close everything.
for (const { drawer, watchers } of rooms) {
  try { drawer.ws.close() } catch {}
  for (const w of watchers) { try { w.ws.close() } catch {} }
}
await new Promise((r) => setTimeout(r, 1000))

function percentile(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const billed = Math.round(connections + stats.sent / 20 + alarms)
console.log(`load window end:   ${endISO} (UTC) / ${amsterdam(endAt)} (Europe/Amsterdam)`)
console.log(
  `--- load counters: connections=${connections} sockets_failed=${stats.failed} sent=${stats.sent} ` +
    `received=${stats.recv} clientErrors=${stats.errors} unexpectedCloses=${stats.unexpected.length} ` +
    `latency_samples=${lat.length} p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms`
)
console.log(`--- projected billed requests for this run: ${billed} (projection ${projected})`)
console.log(`--- projection for ONE 10-min 10-player game: ${game10x10} billed requests (+ alarms)`)

// One JSONL row per run. Contains metrics only: no tokens, IPs, names, or
// room codes. Committed so the free-tier reconciliation has a machine-readable
// record of every run.
if (process.env.LOAD_LEDGER) {
  const row = {
    run: endISO,
    start_utc: startISO,
    end_utc: endISO,
    start_ams: amsterdam(startAt),
    end_ams: amsterdam(endAt),
    rooms: ROOMS,
    clients: CLIENTS,
    seconds: SECONDS,
    draw_hz: DRAW_HZ,
    cursor_hz: CURSOR_HZ,
    connections,
    incoming: stats.sent,
    alarms,
    projected_billed: billed,
    received: stats.recv,
    clientErrors: stats.errors,
    unexpectedCloses: stats.unexpected.length,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
  }
  appendFileSync(process.env.LOAD_LEDGER, JSON.stringify(row) + '\n')
  console.log(`--- appended ledger row to ${process.env.LOAD_LEDGER}`)
}

check('load: no unexpected server-initiated closes', stats.unexpected.length === 0)
check('load: broadcast latency p95 under 1000ms', (percentile(lat, 95) ?? 9999) < 1000)
summary('load')
