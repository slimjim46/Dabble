// Hibernation suite: keep sockets open and completely idle for 10 minutes,
// then prove the Worker still auto-answers a literal "ping" with "pong" and
// that the Durable Object wakes from hibernation with its state intact.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev \
//     node tests/hibernate.mjs
//
// Long (10 min). The exact UTC window is printed at the start and the end.
import { anonUser, check, connect, createRoom, sleep, summary } from './helpers.mjs'

const IDLE_MS = 10 * 60 * 1000
const uid = () => crypto.randomUUID()
const randKey = () => 'k' + Math.random().toString(36).slice(2, 12)

const host = await anonUser()
const { status, body } = await createRoom(host.token)
if (status !== 201) throw new Error(`room create failed: ${status} ${JSON.stringify(body)}`)
const code = body.code
const peer = await anonUser()
const hostConn = await connect(code, host.token)
const peerConn = await connect(code, peer.token)
check('setup: host connected', hostConn.status === 101)
check('setup: peer connected', peerConn.status === 101)

// Baseline: a normal message works before idling.
{
  const k = randKey()
  hostConn.ws.send(JSON.stringify({ v: 1, t: 'cursor', k, x: 50, y: 50 }))
  const hit = await peerConn.waitFor((m) => m.t === 'cursor' && m.k === k, 5000)
  check('baseline: cursor delivered before idle', !!hit)
}

const startISO = new Date().toISOString()
console.log(`hibernate window start (UTC): ${startISO}  (idling ${IDLE_MS / 60000} min)`)

// Idle in slices so an unexpected server close is noticed promptly.
let closedEarly = false
for (let elapsed = 0; elapsed < IDLE_MS; elapsed += 30000) {
  await sleep(Math.min(30000, IDLE_MS - elapsed))
  if (hostConn.closed || peerConn.closed) {
    closedEarly = true
    break
  }
}
const endISO = new Date().toISOString()
console.log(`hibernate window end   (UTC): ${endISO}`)

check('sockets stayed open across the idle window', !closedEarly && !hostConn.closed && !peerConn.closed)

// 1. Literal ping -> pong, answered by the runtime auto-response.
{
  const before = hostConn.messages.length
  hostConn.ws.send('ping')
  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    await sleep(50)
    pong = hostConn.messages.slice(before).find((m) => m === 'pong') || null
  }
  check('literal "ping" got "pong" after hibernation', !!pong)
}

// 2. A normal cursor still reaches the peer (DO woke, state intact).
{
  const k = randKey()
  hostConn.ws.send(JSON.stringify({ v: 1, t: 'cursor', k, x: 123, y: 321 }))
  const hit = await peerConn.waitFor((m) => m.t === 'cursor' && m.k === k, 8000)
  check('normal cursor works after hibernation', !!hit)
}

// 3. A stroke works end to end (ownership attachment survived hibernation).
{
  const id = uid()
  const k = randKey()
  hostConn.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k, id, userId: uid(), userName: 'Hib', color: '#00ff00', width: 2, pts: [1, 1] }))
  hostConn.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k, id, seq: 1, pts: [2, 2] }))
  hostConn.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k, stroke: { id, userId: uid(), userName: 'Hib', color: '#00ff00', width: 2, points: [1, 1, 2, 2] } }))
  const hit = await peerConn.waitFor((m) => m.t === 'stroke_end' && m.k === k, 8000)
  check('full stroke works after hibernation', !!hit)
}

hostConn.ws.close()
peerConn.ws.close()
summary('hibernate')
