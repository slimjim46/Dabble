// A human-readable v2 Phase 3 step 2 walkthrough: one whole game on the dev
// worker, printing every phase change, hint and reveal. Also asserts the
// secret never reaches a non-drawer and the round is cleared between rounds.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev \
//     node tests/game-walkthrough.mjs
//
// Plain script (not *.test.mjs): run it by hand; it takes ~2 minutes.
import { appendFileSync } from 'node:fs'
import { anonUser, check, connect, createRoom, summary } from './helpers.mjs'

const PLAYERS = Number(process.env.PLAYERS || 3)
const DRAW_HZ = Number(process.env.DRAW_HZ || 0) // 0 keeps the single-doodle behaviour
const WRONG_GUESSES = Number(process.env.WRONG_GUESSES || 0)
const LATE_JOIN = process.env.LATE_JOIN !== '0'
const pick = (i) => JSON.stringify({ v: 1, t: 'pick', i })
const start = JSON.stringify({ v: 1, t: 'start' })
const revealed = (hint) => [...(hint || '')].filter((c) => c !== '_' && c !== ' ').length

// Cost measurement: count every incoming (client -> server) data message by
// type and every incoming ping. Pings use the Cloudflare auto-response and do
// not wake the Durable Object, so they are reported but excluded from billing.
const stats = { connections: 0, sent: 0, pings: 0, byType: {} }
function track(c) {
  stats.connections++
  const send = c.ws.send.bind(c.ws)
  c.ws.send = (data) => {
    stats.sent++
    let m
    try { m = JSON.parse(String(data)) } catch {}
    if (m?.t) stats.byType[m.t] = (stats.byType[m.t] || 0) + 1
    return send(data)
  }
  if (typeof c.ws.ping === 'function') {
    const ping = c.ws.ping.bind(c.ws)
    c.ws.ping = (...a) => { stats.pings++; return ping(...a) }
  }
}
const AMS = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'medium' })
const amsterdam = (d) => AMS.format(d)

const host = await anonUser()
const { body } = await createRoom(host.token)
const code = body.code
const users = [host]
for (let i = 1; i < PLAYERS; i++) users.push(await anonUser())
const conns = []
for (const u of users) { const c = await connect(code, u.token); track(c); conns.push(c) }
const byUser = new Map(users.map((u, i) => [u.userId, conns[i]]))
console.log(`room ${code}, ${PLAYERS} players, ${conns[0].json()[1]?.rounds ?? '?'} rounds`)

const startAt = new Date()
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

  // Realistic drawer stroke: start now, stream points through the hint waits,
  // then end it before the guesses trigger an early finish. With DRAW_HZ 0 this
  // degrades to the single stroke_start/stroke_end doodle of the original.
  const id = crypto.randomUUID()
  drawer.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: `w${round}`, id, userId: 'x', userName: 'x', color: '#30a46c', width: 5, pts: [10, 10] }))
  let strokeSeq = 0
  const strokeTimer = DRAW_HZ > 0
    ? setInterval(() => {
        strokeSeq++
        drawer.ws.send(JSON.stringify({ v: 1, t: 'stroke_points', k: `w${round}`, id, seq: strokeSeq, pts: [(10 + strokeSeq) % 2000, (20 + strokeSeq * 3) % 2000] }))
      }, Math.round(1000 / DRAW_HZ))
    : null

  const h1 = await drawer.waitFor((m) => m.t === 'state' && m.round === round && m.phase === 'drawing' && m.hint && revealed(m.hint) > 0, 9000)
  const h2 = await drawer.waitFor((m) => m.t === 'state' && m.round === round && m.phase === 'drawing' && m.hint && revealed(m.hint) > revealed(h1?.hint), 7000)
  console.log(`[round ${round}] hint 1 "${h1?.hint}" -> hint 2 "${h2?.hint}"`)
  check(`round ${round}: hints never reveal the whole word`,
    !!h1 && !!h2 && revealed(h1.hint) < word.length && revealed(h2.hint) < word.length)

  if (strokeTimer) clearInterval(strokeTimer)
  drawer.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: `w${round}`, stroke: { id, userId: 'x', userName: 'x', color: '#30a46c', width: 5, points: [10, 10, 40, 40, 80, 20] } }))

  // Every non-drawer guesses correctly after a few deliberate misses (real
  // Guess-mode traffic): the round should finish early (before the ~12 s
  // drawing timer on the fast worker) and score both sides. The script knows
  // the word, so it can drive guesses a real client could only make by knowing it.
  for (const c of conns) {
    if (c === drawer) continue
    for (let g = 0; g < WRONG_GUESSES; g++) c.ws.send(JSON.stringify({ v: 1, t: 'guess', text: 'zzzz' }))
    c.ws.send(JSON.stringify({ v: 1, t: 'guess', text: word }))
  }
  const rev = await drawer.waitFor((m) => m.t === 'reveal' && m.round === round, 18000)
  console.log(`[round ${round}] reveal word="${rev?.word}" skipped=${rev?.skipped}`)
  console.log(`[round ${round}] gains ${JSON.stringify(rev?.gains)}`)
  check(`round ${round}: reveal matches the drawing word`, rev?.word === word && rev.skipped === false)
  check(`round ${round}: reveal carries per-round gains`, !!rev?.gains && Object.keys(rev.gains).length > 0, JSON.stringify(rev?.gains))
  check(`round ${round}: the non-drawer never saw the word before the reveal`,
    !other.json().some((m) => m.t !== 'reveal' && m.round === round && JSON.stringify(m).includes(word)))

  if (round === 1 && LATE_JOIN) {
    const pick2 = await conns[0].waitFor((m) => m.t === 'state' && m.round === 2 && m.phase === 'pick', 12000)
    check('round 2: transition announced', !!pick2)
    const late = await connect(code, (await anonUser()).token)
    track(late)
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
const endAt = new Date()
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

const gameSeconds = Math.round((endAt - startAt) / 1000)
const billed = Math.round(stats.connections + stats.sent / 20)
console.log(`--- guess-mode counters: connections=${stats.connections} incoming=${stats.sent} byType=${JSON.stringify(stats.byType)} pings=${stats.pings}`)
console.log(`--- game length ${gameSeconds}s, billed (connections + incoming/20) = ${billed}`)
if (process.env.LOAD_LEDGER) {
  const row = {
    run: endAt.toISOString(),
    start_utc: startAt.toISOString(),
    end_utc: endAt.toISOString(),
    start_ams: amsterdam(startAt),
    end_ams: amsterdam(endAt),
    mode: 'guess',
    players: PLAYERS,
    draw_hz: DRAW_HZ,
    wrong_guesses: WRONG_GUESSES,
    late_join: LATE_JOIN,
    connections: stats.connections,
    incoming: stats.sent,
    incoming_by_type: stats.byType,
    pings: stats.pings,
    game_seconds: gameSeconds,
    billed,
  }
  appendFileSync(process.env.LOAD_LEDGER, JSON.stringify(row) + '\n')
  console.log(`--- appended ledger row to ${process.env.LOAD_LEDGER}`)
}

for (const c of conns) await c.close()
summary('game-walkthrough')
