// A human-readable v2 Phase 3 step 2 walkthrough: one whole game on the dev
// worker, printing every phase change, hint and reveal. Also asserts the
// secret never reaches a non-drawer and the round is cleared between rounds.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev.rowan-dev-workers.workers.dev \
//     node tests/game-walkthrough.mjs
//
// Plain script (not *.test.mjs): run it by hand; it takes ~2 minutes.
import { anonUser, check, connect, createRoom, summary } from './helpers.mjs'

const PLAYERS = Number(process.env.PLAYERS || 3)
const pick = (i) => JSON.stringify({ v: 1, t: 'pick', i })
const start = JSON.stringify({ v: 1, t: 'start' })
const revealed = (hint) => [...(hint || '')].filter((c) => c !== '_' && c !== ' ').length

const host = await anonUser()
const { body } = await createRoom(host.token)
const code = body.code
const users = [host]
for (let i = 1; i < PLAYERS; i++) users.push(await anonUser())
const conns = []
for (const u of users) conns.push(await connect(code, u.token))
const byUser = new Map(users.map((u, i) => [u.userId, conns[i]]))
console.log(`room ${code}, ${PLAYERS} players, ${conns[0].json()[1]?.rounds ?? '?'} rounds`)

conns[0].ws.send(start)
const drawerHistory = []

for (let round = 1; round <= 6; round++) {
  const st = await conns[0].waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === round, round === 1 ? 5000 : 25000)
  if (!st) {
    check(`round ${round}: entered pick`, false)
    break
  }
  const drawer = byUser.get(st.drawer)
  const other = conns.find((c) => c !== drawer)
  const wp = await drawer.waitFor((m) => m.t === 'word_pick' && m.round === round, 5000)
  if (!wp) {
    check(`round ${round}: drawer got options`, false)
    break
  }
  drawerHistory.push(st.drawer)
  console.log(`[round ${round}] pick  drawer=${st.drawer.slice(0, 8)} options=${wp.options.join(' / ')}`)
  check(`round ${round}: non-drawer never sees options`,
    !other.json().some((m) => m.t === 'word_pick' && m.round === round))
  const word = wp.options[0]
  drawer.ws.send(pick(0))

  const drawing = await drawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.round === round, 5000)
  const your = await drawer.waitFor((m) => m.t === 'your_word' && m.round === round, 3000)
  check(`round ${round}: drawer receives its word`, your?.word === word)
  console.log(`[round ${round}] draw  word="${word}" len=${drawing?.wordLen} hint="${drawing?.hint}"`)

  const h1 = await drawer.waitFor((m) => m.t === 'state' && m.round === round && m.phase === 'drawing' && m.hint && revealed(m.hint) > 0, 9000)
  const h2 = await drawer.waitFor((m) => m.t === 'state' && m.round === round && m.phase === 'drawing' && m.hint && revealed(m.hint) > revealed(h1?.hint), 7000)
  console.log(`[round ${round}] hint 1 "${h1?.hint}" -> hint 2 "${h2?.hint}"`)
  check(`round ${round}: hints never reveal the whole word`,
    !!h1 && !!h2 && revealed(h1.hint) < word.length && revealed(h2.hint) < word.length)

  // Doodle in every round so the next round's clear has something to remove.
  const id = crypto.randomUUID()
  drawer.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: `w${round}`, id, userId: 'x', userName: 'x', color: '#30a46c', width: 5, pts: [10, 10] }))
  drawer.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: `w${round}`, stroke: { id, userId: 'x', userName: 'x', color: '#30a46c', width: 5, points: [10, 10, 40, 40, 80, 20] } }))

  // Every non-drawer guesses correctly: the round should finish early (before
  // the ~12 s drawing timer on the fast worker) and score both sides. The
  // script knows the word, so it can drive the guesses that a real client
  // could only make by knowing it.
  for (const c of conns) {
    if (c === drawer) continue
    c.ws.send(JSON.stringify({ v: 1, t: 'guess', text: word }))
  }
  const rev = await drawer.waitFor((m) => m.t === 'reveal' && m.round === round, 18000)
  console.log(`[round ${round}] reveal word="${rev?.word}" skipped=${rev?.skipped}`)
  console.log(`[round ${round}] gains ${JSON.stringify(rev?.gains)}`)
  check(`round ${round}: reveal matches the drawing word`, rev?.word === word && rev.skipped === false)
  check(`round ${round}: reveal carries per-round gains`, !!rev?.gains && Object.keys(rev.gains).length > 0, JSON.stringify(rev?.gains))
  check(`round ${round}: the non-drawer never saw the word before the reveal`,
    !other.json().some((m) => m.t !== 'reveal' && m.round === round && JSON.stringify(m).includes(word)))

  if (round === 1) {
    const pick2 = await conns[0].waitFor((m) => m.t === 'state' && m.round === 2 && m.phase === 'pick', 12000)
    check('round 2: transition announced', !!pick2)
    const late = await connect(code, (await anonUser()).token)
    const snap = await late.waitFor((m) => m.t === 'snapshot', 3000)
    const ls = await late.waitFor((m) => m.t === 'state' && m.round === 2 && m.phase === 'pick', 3000)
    console.log(`[round 2] late join snapshot round=${snap?.round} strokes=${snap?.strokes?.length}`)
    check('round 2: the previous round\'s strokes were cleared', snap?.round === 2 && snap?.strokes?.length === 0)
    check('round 2: the late joiner did not replace the drawer', ls?.drawer === pick2?.drawer)
    check('round 2: the late joiner received no secret', !late.json().some((m) => m.t === 'word_pick' || m.t === 'your_word'))
    await late.close()
  }
}

const over = await conns[0].waitFor((m) => m.t === 'state' && m.phase === 'game_over', 12000)
console.log(`[game over] manager state received=${!!over}`)
const totals = over?.scores || {}
const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1])
console.log('[game over] final totals:')
for (const [uid, pts] of ranked) console.log(`  ${uid.slice(0, 8)}  ${pts}`)
check('game over: every seat has a final score', Object.keys(totals).length > 0, JSON.stringify(totals))
const lobby = await conns[0].waitFor((m) => m.t === 'state' && m.phase === 'lobby', 12000)
console.log(`[lobby] back at rounds=${lobby?.rounds} drawer=${lobby?.drawer}`)
check('game over returns to the lobby', !!lobby && lobby.rounds === 0 && lobby.drawer === null)
check('game over: the lobby cleared the scores', !lobby?.scores || Object.keys(lobby.scores).length === 0, JSON.stringify(lobby?.scores))
check('every player drew once per turn', new Set(drawerHistory).size === PLAYERS && drawerHistory.length === 6)

for (const c of conns) await c.close()
summary('game-walkthrough')
