// Adversarial v2 Phase 3 step 2 script: try the things a hostile player can
// actually send (bad picks, fake start, unknown secret types, post-grace
// reconnect, kick, message flood) and check the server's edge behaviour.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev \
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

// 8. Guessing (v2 Phase 3 step 4a). The word and every guess text stay
// server-side: a guesser who reads their raw WebSocket traffic must never see
// the word or another player's guess, the drawer's guesses are ignored, the
// per-user cap is a transient error (no close), and an ignored-guess flood
// still closes 1008.
{
  const gHost = await anonUser()
  const gb = await createRoom(gHost.token)
  const gCode = gb.body.code
  const gA = await connect(gCode, gHost.token)
  const gU2 = await anonUser()
  const gB = await connect(gCode, gU2.token)
  gA.ws.send(start)
  const gPick = await gA.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  const gDrawer = gPick?.drawer === gHost.userId ? gA : gB
  const gGuesser = gDrawer === gA ? gB : gA
  const gwp = await gDrawer.waitFor((m) => m.t === 'word_pick', 5000)
  const theWord = gwp?.options?.[1] ?? wp?.options?.[1] ?? null
  check('cheat: the drawer got a word to pick', typeof theWord === 'string' && theWord.length > 0)
  gDrawer.ws.send(pick(1))
  await gDrawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)

  // (a) The drawer's own guesses are ignored: no ack, no correct, no text.
  const before = gDrawer.messages.length
  for (let i = 0; i < 3; i++) gDrawer.ws.send(JSON.stringify({ v: 1, t: 'guess', text: theWord }))
  await sleep(400)
  const drawerAcks = gDrawer.json().slice(before).filter((m) => m.t === 'guess_ack')
  check('cheat: a drawer guess is ignored (no ack)', drawerAcks.length === 0, JSON.stringify(drawerAcks))
  check('cheat: a drawer guess never marks anyone correct',
    !gA.json().some((m) => m.t === 'state' && (m.correct ?? []).length > 0))

  // (b) Wrong guesses: private feedback only, generic when not close.
  gGuesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: 'zzzzzzzz' }))
  const wrong = await gGuesser.waitFor((m) => m.t === 'guess_ack' && m.ok === false, 4000)
  check('cheat: a wrong guess gets a private ack with close=false',
    wrong?.ok === false && wrong?.close === false, JSON.stringify(wrong))
  // (c) The other player never sees the guess text anywhere in their traffic.
  const guessed = 'zzzzzzzz'
  check('cheat: another player never sees a guess text',
    !gDrawer.messages.join('\n').includes(guessed))
  check('cheat: the public state frame never carries the secret word',
    gGuesser.json().filter((m) => m.t === 'state').every((m) => !JSON.stringify(m).includes(theWord)))

  // (d) A correct guess: ack to the guesser, "guessed it" to everyone, and the
  // word is STILL not in the public state or on the other socket.
  gGuesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: theWord }))
  const right = await gGuesser.waitFor((m) => m.t === 'guess_ack' && m.ok === true, 4000)
  check('cheat: a correct guess acks ok', right?.ok === true, JSON.stringify(right))
  const pub = await gDrawer.waitFor((m) => m.t === 'state' && (m.correct ?? []).length > 0, 4000)
  check('cheat: everyone sees the public correct list grow', (pub?.correct ?? []).length === 1)
  check('cheat: the public state still masks the word',
    !JSON.stringify(pub).includes(theWord), JSON.stringify(pub))

  // (e) The per-user cap: 21 accepted guesses -> guess_cap error, NO close.
  // Respect the 2/s budget with the same 600 ms the client uses (1.67/s, 20%
  // headroom): five at once, then 600 ms apart, so the cap is what we hit and
  // the rate limit does not close the socket first.
  const capHost = await anonUser()
  const cb = await createRoom(capHost.token)
  const cCode = cb.body.code
  const cA = await connect(cCode, capHost.token)
  const cU2 = await anonUser()
  const cB = await connect(cCode, cU2.token)
  cA.ws.send(start)
  const cPick = await cA.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  const cDrawer = cPick?.drawer === capHost.userId ? cA : cB
  const cGuesser = cDrawer === cA ? cB : cA
  await cDrawer.waitFor((m) => m.t === 'word_pick', 5000)
  cDrawer.ws.send(pick(0))
  await cDrawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  for (let i = 0; i < 5; i++) cGuesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: `wrong${i}` }))
  for (let i = 5; i < 21; i++) {
    await sleep(600)
    cGuesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: `wrong${i}` }))
  }
  const capErr = await cGuesser.waitFor((m) => m.t === 'error' && m.reason === 'guess_cap', 4000)
  check('cheat: the 21st guess is a guess_cap error, not a close', !!capErr, JSON.stringify(cGuesser.json().slice(-3)))
  check('cheat: the capped guesser is not closed', !cGuesser.closed)

  // (f) An ignored-guess flood by the DRAWER still closes 1008 (ignored but
  // billed, exactly like the stroke gate).
  for (let i = 0; i < 200; i++) cDrawer.ws.send(JSON.stringify({ v: 1, t: 'guess', text: 'flood' }))
  const gClosed = await cDrawer.waitForClose(1008, 5000)
  check('cheat: a drawer guess flood still closes 1008', !!gClosed, JSON.stringify(cDrawer.closes))

  for (const c of [gA, gB, cA, cB].filter((c) => !c.closed)) await c.close()
}

for (const c of [a, b, x, back].filter((c) => !c.closed)) await c.close()
summary('game-cheat')