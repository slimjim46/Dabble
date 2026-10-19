// Chaos suite: abuse the disconnect paths against the dev worker.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev \
//     node tests/chaos.mjs
//
// Run `wrangler tail --format json > tail-chaos.log` alongside this and check
// the log afterwards: there must be zero unexpected exception/error events
// (the script itself only sees client-side effects).
//
// Phases: kill sockets mid-message, mass close, reconnect storm, and
// host-disconnect-then-promote churn. Keeps total joins well under the dev
// JOIN_IP 90/min binding so a 429 never muddies the result.
import { anonUser, check, connect, createRoom, probeWs, sleep, summary } from './helpers.mjs'
import { randomCode } from '../src/codes.js'

const ROOMS = 3
const PLAYERS = 3 // + host = 4 sockets/room (<= dev IP cap of 8)

const uid = () => crypto.randomUUID()
const randKey = () => 'k' + Math.random().toString(36).slice(2, 12)

const strokeStart = (id, k) => ({ v: 1, t: 'stroke_start', k, id, userId: uid(), userName: 'Chaos', color: '#30a46c', width: 3, pts: [10, 10] })
const strokePoints = (id, k, seq, x, y) => ({ v: 1, t: 'stroke_points', k, id, seq, pts: [x, y] })
const cursor = (k, x, y) => ({ v: 1, t: 'cursor', k, x, y })

const BAD_CODES = [1008, 1009, 1011, 1012, 1013, 1014]
const stats = { sockets: 0, sent: 0, recv: 0, unexpected: [], cancels: 0, replacements: 0, promotions: 0, http: {} }

function instrument(c) {
  c.ws.on('message', () => stats.recv++)
  c.ws.on('close', (code) => {
    if (BAD_CODES.includes(code)) stats.unexpected.push(code)
    if (code === 4009) stats.replacements++
  })
}
function send(c, obj) {
  stats.sent++
  c.ws.send(JSON.stringify(obj))
}
async function newConn(code, token) {
  const c = await connect(code, token)
  if (c.status === 101) {
    stats.sockets++
    instrument(c)
  } else {
    // Every non-101 is an intentional/expected HTTP rejection: record it so
    // the dashboard DO-error delta over this window can be compared with it.
    stats.http[c.status] = (stats.http[c.status] || 0) + 1
  }
  return c
}

// ---- Setup: rooms with a known join order --------------------------------
const startISO = new Date().toISOString()
const rooms = []
for (let r = 0; r < ROOMS; r++) {
  const host = await anonUser()
  const { status, body } = await createRoom(host.token)
  if (status !== 201) throw new Error(`room create failed: ${status} ${JSON.stringify(body)}`)
  const code = body.code
  const hostConn = await newConn(code, host.token)
  const players = []
  for (let i = 0; i < PLAYERS; i++) {
    const u = await anonUser()
    players.push({ ...u, conn: await newConn(code, u.token) })
  }
  rooms.push({ code, host, hostConn, players })
}
check('setup: every host + player connected', rooms.every((r) => r.hostConn.status === 101 && r.players.every((p) => p.conn.status === 101)), `${stats.sockets} sockets`)

// ---- Phase A: kill a socket mid-stroke -> others get stroke_cancel -------
for (const room of rooms) {
  const id = uid()
  const k = randKey()
  send(room.hostConn, strokeStart(id, k))
  for (let s = 1; s <= 5; s++) send(room.hostConn, strokePoints(id, k, s, 10 + s, 10 + s))
  await sleep(150) // let the DO process the start + points
  room.hostConn.ws.terminate() // abrupt: no stroke_end, no close frame
  const seen = []
  for (const p of room.players) {
    const hit = await p.conn.waitFor((m) => m.t === 'stroke_cancel' && m.id === id, 4000)
    seen.push(!!hit)
  }
  if (seen.every(Boolean)) stats.cancels++
}
check('phase A: abrupt mid-stroke death broadcasts stroke_cancel to every peer', stats.cancels === ROOMS, `${stats.cancels}/${ROOMS} rooms`)

// ---- Phase B: mass close, then prove the room is still joinable ----------
const survivors = []
for (const room of rooms) for (const p of room.players) survivors.push({ room, conn: p.conn })
for (const { conn } of survivors) conn.ws.terminate()
await sleep(500)
let rejoins = 0
for (const room of rooms) {
  const u = await anonUser()
  const c = await newConn(room.code, u.token)
  if (c.status === 101 && c.welcome) rejoins++
  if (c.status === 101) c.ws.close()
}
check('phase B: rooms survive a simultaneous mass close', rejoins === ROOMS, `${rejoins}/${ROOMS} rejoined`)

// ---- Phase C: reconnect storm (same user reopening while still open) -----
const first = rooms[0]
const stormUsers = [{ token: first.host.token }, ...first.players.map((p) => ({ token: p.token }))]
const stormConns = []
// Reopen the same user WITHOUT closing: the DO must close the older socket
// with 4009 each round. Kept sequential so the room's per-IP cap never trips.
for (let round = 0; round < 3; round++) {
  for (const u of stormUsers) {
    const c = await newConn(first.code, u.token)
    if (c.status === 101) stormConns.push(c)
    await sleep(60)
  }
  await sleep(150)
}
for (const c of stormConns) c.ws.close()
check('phase C: reconnect storm completes without unexpected closes', stats.unexpected.length === 0, `${stats.replacements} 4009 replacements observed`)
check('phase C: same-user reconnect replaced older sockets (4009)', stats.replacements >= stormUsers.length, `${stats.replacements} replacements`)

// ---- Phase D: host disconnect -> seat released -> new host promoted ------
// Fresh room with a known order, because phases A/B already killed room 2's
// peers. Kill the host abruptly, wait out the dev SEAT_HOLD_MS (5 s) so the
// alarm releases the host seat and promotes the longest-connected peer.
{
  const dhost = await anonUser()
  const d = await createRoom(dhost.token)
  if (d.status !== 201) throw new Error(`phase D create failed: ${d.status}`)
  const dcode = d.body.code
  const dhostConn = await newConn(dcode, dhost.token)
  const peers = []
  for (let i = 0; i < 2; i++) {
    const u = await anonUser()
    peers.push(await newConn(dcode, u.token))
  }
  check('phase D: fresh host + 2 peers connected', dhostConn.status === 101 && peers.every((p) => p.status === 101))

  dhostConn.ws.terminate() // abrupt host loss
  const promoted = await Promise.race(
    peers.map((p) => p.waitFor((m) => m.t === 'presence' && m.event === 'host' && typeof m.userId === 'string', 12000))
  )
  if (promoted) stats.promotions++
  check('phase D: a new host is promoted after the host seat is released', !!promoted, promoted ? `host=${String(promoted.userId).slice(0, 8)}` : 'no host event')

  const back = await newConn(dcode, dhost.token)
  check('phase D: returning ex-host is not host again', back.status === 101 && back.welcome?.host === false, `host=${back.welcome?.host}`)
  if (back.status === 101) back.ws.close()
  for (const p of peers) p.ws.close()
}

// ---- Phase E: a known count of DO-level 4xx probes -----------------------
// Joins against valid-format codes that do not exist reach the Room DO and
// get its 404 (probe_404). This is the intentional 4xx ledger used to explain
// the dashboard DO-error delta over this window.
const INTENTIONAL_404 = 8
let got404 = 0
for (let i = 0; i < INTENTIONAL_404; i++) {
  const u = await anonUser()
  const r = await probeWs(randomCode(), ['dabble.v1', u.token])
  if (r.status === 404) got404++
  else stats.http[r.status] = (stats.http[r.status] || 0) + 1
}
check('phase E: all nonexistent-room joins returned DO 404', got404 === INTENTIONAL_404, `${got404}/${INTENTIONAL_404}`)

const endISO = new Date().toISOString()
console.log(`chaos window (UTC): ${startISO} -> ${endISO}`)
console.log(`chaos intentional non-101 HTTP statuses: ${JSON.stringify(stats.http)}`)
console.log(
  `--- chaos counters: sockets=${stats.sockets} sent=${stats.sent} recv=${stats.recv} ` +
    `cancels=${stats.cancels} replacements4009=${stats.replacements} promotions=${stats.promotions} ` +
    `unexpectedCloses=${stats.unexpected.length}${stats.unexpected.length ? ' ' + JSON.stringify(stats.unexpected) : ''}`
)
check('chaos: no unexpected server-initiated close codes', stats.unexpected.length === 0)

summary('chaos')
