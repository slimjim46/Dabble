// Adversarial v2 Phase 3 step 2 script: try the things a hostile player can
// actually send (bad picks, fake start, unknown secret types, post-grace
// reconnect, kick, message flood) and check the server's edge behaviour.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev \
//     node tests/game-cheat.mjs
import { anonUser, check, connect, createRoom, sleep, summary } from './helpers.mjs'

const start = JSON.stringify({ v: 1, t: 'start' })
const pick = (i) => JSON.stringify({ v: 1, t: 'pick', i })

const host = await anonUser()
const { body } = await createRoom(host.token)
const code = body.code
const player = await anonUser()
const intruder = await anonUser()
const a = await connect(code, host.token)
const b = await connect(code, player.token)
const x = await connect(code, intruder.token)
console.log(`room ${code}: host=${a.welcome?.seat} player=${b.welcome?.seat} intruder=${x.welcome?.seat}`)

// 1. Lobby abuse: fake starts from a non-host, many times.
for (let i = 0; i < 5; i++) x.ws.send(start)
await sleep(400)
check('non-host start spam never starts the game', !a.json().some((m) => m.t === 'state' && m.phase === 'pick'))

a.ws.send(start)
const pickState = await a.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
check('the host can start with three seats', !!pickState)
const allUsers = [host, player, intruder]
const allConns = [a, b, x]
const connFor = (uid) => allConns[allUsers.findIndex((u) => u.userId === uid)]
const userFor = (conn) => allUsers[allConns.indexOf(conn)]
const drawer = connFor(pickState?.drawer)
const bystanders = allConns.filter((c) => c !== drawer)
const wp = await drawer.waitFor((m) => m.t === 'word_pick', 5000)
const word = wp?.options?.[0] ?? null
console.log(`drawer is seat ${drawer?.welcome?.seat}, options=${wp?.options?.join(' / ')}`)

// 2. Pick abuse: non-drawers, out of range, wrong types, repeated.
for (const c of bystanders) for (let i = 0; i < 3; i++) c.ws.send(pick(i % 3))
for (const bad of ['-1', '99', '1.5', '"0"', 'null']) drawer.ws.send(`{"v":1,"t":"pick","i":${bad}}`)
await sleep(500)
check('bad picks never advance the phase', !a.json().some((m) => m.t === 'state' && m.phase === 'drawing'))
check('the drawer still has its options after bad picks', !!wp && drawer.json().filter((m) => m.t === 'word_pick').length === 1)

// 3. Fake secret/unknown message types count as violations, never leak.
x.ws.send(JSON.stringify({ v: 1, t: 'your_word', round: 1, word: 'cheat' }))
x.ws.send(JSON.stringify({ v: 1, t: 'word_pick', round: 1, options: ['a', 'b', 'c'] }))
await sleep(300)
check('unknown types do not close a normal player', !x.closed)
check('a bystander never receives a secret', !bystanders.some((c) =>
  c.json().some((m) => m.t === 'word_pick' || m.t === 'your_word')))

// 4. Kick a bystander while the host is still host: ack + 4003.
check('the round 1 drawer is the host (seat 0)', drawer === a)
a.ws.send(JSON.stringify({ v: 1, t: 'kick', userId: intruder.userId }))
const ack = await a.waitFor((m) => m.t === 'kick_ack' && m.userId === intruder.userId, 5000)
const kicked = await x.waitForClose(4003, 5000)
check('kick is acknowledged and closes 4003', !!ack && !!kicked)

// 5. A real pick draws; the drawer leaves, and the round is skipped after the
// grace. Observe from a bystander (the drawer's own socket is the one gone).
drawer.ws.send(pick(0))
const drawing = await drawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
check('the drawer can pick after the abuse', !!drawing)
const drawerUser = pickState.drawer
const observer = bystanders.find((c) => c !== x && c !== drawer)
await drawer.close()
const rev = await observer.waitFor((m) => m.t === 'reveal' && m.round === 1, 10000)
check('after the 3 s grace the round is skipped', rev?.skipped === true)

// Reconnect after the skip: the join is public, so no your_word.
const tokenFor = (uid) => (uid === host.userId ? host.token : uid === player.userId ? player.token : intruder.token)
const back = await connect(code, tokenFor(drawerUser))
console.log('late reconnect while reveal/scores is public:',
  JSON.stringify(back.json().slice(0, 5).map((m) => m.t)))
check('a post-grace reconnect gets no your_word', !back.json().some((m) => m.t === 'your_word'))
check('the reconnect gets the public reveal', back.json().some((m) => m.t === 'reveal'))

// 6. Message flood: the per-socket budget closes with 1008.
for (let i = 0; i < 40; i++) back.ws.send(start)
const flooded = await back.waitForClose(1008, 5000)
check('a sustained flood closes 1008', !!flooded, JSON.stringify(back.closes))

// 7. The drawer gate must NOT shelter a flood: ignored strokes are still
// billed and still count against the per-type budget, so a non-drawer stroke
// flood closes 1008 exactly like any other flood. Start a fresh game and
// flood with stroke_points while a bystander is connected.
{
  const fHost = await anonUser()
  const fb = await createRoom(fHost.token)
  const fCode = fb.body.code
  const fA = await connect(fCode, fHost.token)
  const fU2 = await anonUser()
  const fB = await connect(fCode, fU2.token)
  fA.ws.send(start)
  const fPick = await fA.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  // Whoever is not the round-1 drawer floods with stroke_points. Let the
  // drawer pick first so the gate is exercised inside the drawing phase.
  const drawerConn = fPick?.drawer === fHost.userId ? fA : fB
  const flooder = drawerConn === fA ? fB : fA
  await drawerConn.waitFor((m) => m.t === 'word_pick', 5000)
  drawerConn.ws.send(pick(0))
  await drawerConn.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  const wid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  for (let i = 0; i < 80; i++) {
    flooder.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: 'f', id: wid, seq: i + 1, pts: [1, 1] }))
  }
  const fClosed = await flooder.waitForClose(1008, 5000)
  check('a non-drawer stroke flood still closes 1008 (ignored but budget-counted)',
    !!fClosed, JSON.stringify(flooder.closes))
  await fA.close()
  await fB.close()
}

for (const c of [a, b, x, back].filter((c) => !c.closed)) await c.close()
summary('game-cheat')
