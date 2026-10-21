// Live v2 Phase 3 step 2 tests against the dev worker (dev Supabase, short
// dev game timings). One full 6-round game plus the edge cases that only a
// real DO/alarm can prove: hints, round clear, drawer grace/reconnect, too-few
// abort, kick-a-drawer and the secret word never reaching a non-drawer.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev \
//     node tests/game-live.test.mjs
import { anonUser, check, connect, createRoom, sleep, summary } from './helpers.mjs'

const pick = (i) => JSON.stringify({ v: 1, t: 'pick', i })
const start = JSON.stringify({ v: 1, t: 'start' })
const kick = (userId) => JSON.stringify({ v: 1, t: 'kick', userId })
const revealed = (hint) => [...(hint || '')].filter((c) => c !== '_' && c !== ' ').length

// A complete stroke for one wire key: start (first point), one points batch,
// end. Enough to exercise the drawer gate end to end.
function strokeFrames(k, id) {
  const base = { v: 1, k, id, userId: 'x', userName: 'x', color: '#30a46c', width: 5 }
  return {
    start: JSON.stringify({ ...base, t: 'stroke_start', pts: [10, 10] }),
    points: JSON.stringify({ v: 1, t: 'stroke_points', k, id, seq: 1, pts: [20, 20, 30, 30] }),
    end: JSON.stringify({ v: 1, t: 'stroke_end', k, stroke: { id, userId: 'x', userName: 'x', color: '#30a46c', width: 5, points: [10, 10, 20, 20, 30, 30] } }),
  }
}

async function roomWith(n) {
  const host = await anonUser()
  const { status, body } = await createRoom(host.token)
  if (status !== 201) throw new Error(`create failed: ${status} ${JSON.stringify(body)}`)
  const users = [host]
  for (let i = 1; i < n; i++) users.push(await anonUser())
  const conns = []
  for (const u of users) conns.push(await connect(body.code, u.token))
  return { code: body.code, users, conns, host: conns[0] }
}

const closeAll = async (conns) => {
  for (const c of conns) await c.close()
}

// ===========================================================================
// A. Full game: start, rotation, pick secrecy, hints, draw, reveal, scores,
//    round clear, game over, lobby.
// ===========================================================================
{
  const host = await anonUser()
  const { body } = await createRoom(host.token)
  const code = body.code
  const a = await connect(code, host.token)
  const users = [host]
  const conns = [a]
  check('A: join order is welcome -> state -> snapshot',
    a.json().slice(0, 3).map((m) => m.t).join(',') === 'welcome,state,snapshot',
    JSON.stringify(a.json().slice(0, 4).map((m) => m.t)))
  check('A: the join state is the lobby', a.json()[1]?.phase === 'lobby', JSON.stringify(a.json()[1]))

  // Too few: a start with one seat must do nothing.
  a.ws.send(start)
  await sleep(300)
  check('A: start with one seat is ignored', !a.json().some((m) => m.t === 'state' && m.phase === 'pick'))

  const peerUser = await anonUser()
  users.push(peerUser)
  const b = await connect(code, peerUser.token)
  conns.push(b)
  check('A: both players connected', !!a.welcome && !!b.welcome)
  b.ws.send(start)
  await sleep(300)
  check('A: a non-host start is ignored', !a.json().some((m) => m.t === 'state' && m.phase === 'pick'))

  a.ws.send(start)
  const first = await a.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === 1, 8000)
  check('A: host start enters pick round 1', !!first, JSON.stringify(first))
  check('A: 2 players -> 6 rounds', first?.rounds === 6, String(first?.rounds))
  check('A: first drawer is seat 0 (the host)', first?.drawer === users[0].userId, JSON.stringify(first?.drawer))

  a.ws.send(start)
  await sleep(250)
  check('A: start mid-game is ignored', a.json().filter((m) => m.t === 'state' && m.phase === 'pick').length === 1)

  const drawerByRound = []
  let wordSeen = null

  for (let round = 1; round <= 6; round++) {
    const state = await a.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === round, round === 1 ? 3000 : 25000)
    if (!state) {
      check(`A: round ${round} entered pick`, false)
      break
    }
    const drawer = state.drawer
    drawerByRound.push(drawer)
    const drawerConn = conns[users.findIndex((u) => u.userId === drawer)]
    const other = conns.find((c) => c !== drawerConn)
    check(`A: round ${round} drawer follows the seat rotation`,
      drawer === users[(round - 1) % 2].userId, `${drawer} vs ${users[(round - 1) % 2].userId}`)

    const wordPick = await drawerConn.waitFor((m) => m.t === 'word_pick' && m.round === round, 5000)
    if (!wordPick) {
      check(`A: round ${round} drawer got word_pick`, false)
      break
    }
    const word = wordPick.options[0]
    if (round === 1) wordSeen = word
    check(`A: round ${round} word_pick has 3 distinct options`,
      wordPick.options.length === 3 && new Set(wordPick.options).size === 3)
    check(`A: round ${round} the non-drawer never got word_pick`,
      !other.json().some((m) => m.t === 'word_pick' && m.round === round))

    // A non-drawer pick must not advance the phase.
    other.ws.send(pick(1))
    await sleep(200)
    check(`A: round ${round} a non-drawer pick is ignored`,
      !other.json().some((m) => m.t === 'state' && m.phase === 'drawing' && m.round === round))

    drawerConn.ws.send(pick(0))
    const drawing = await drawerConn.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.round === round, 5000)
    if (!drawing) {
      check(`A: round ${round} entered drawing`, false)
      break
    }
    check(`A: round ${round} state masks the word`,
      drawing.wordLen === word.length && drawing.hint === '_'.repeat(word.length) && !JSON.stringify(drawing).includes(word),
      JSON.stringify(drawing))
    const your = await drawerConn.waitFor((m) => m.t === 'your_word' && m.round === round, 3000)
    check(`A: round ${round} drawer got your_word`, your?.word === word, JSON.stringify(your))

    if (round === 1) {
      const h1 = await drawerConn.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.hint && revealed(m.hint) > 0, 9000)
      check('A: first hint is broadcast mid-round',
        !!h1 && h1.round === round && revealed(h1.hint) < word.length, JSON.stringify(h1))
      const h2 = await drawerConn.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.hint && revealed(m.hint) > revealed(h1?.hint), 7000)
      check('A: second hint reveals more letters, never all',
        !!h2 && revealed(h2.hint) < word.length, JSON.stringify(h2))
      check('A: hints never contain the word', ![h1, h2].some((m) => m && JSON.stringify(m).includes(word)))

      // Draw during the round so the next snapshot has something to clear.
      const id = crypto.randomUUID()
      drawerConn.ws.send(JSON.stringify({ v: 1, t: 'stroke_start', k: 'gk', id, userId: 'x', userName: 'x', color: '#e5484d', width: 5, pts: [10, 10] }))
      await sleep(100)
      drawerConn.ws.send(JSON.stringify({ v: 1, t: 'stroke_end', k: 'gk', stroke: { id, userId: 'x', userName: 'x', color: '#e5484d', width: 5, points: [10, 10, 20, 20] } }))
      await sleep(300)
    }

    const reveal = await drawerConn.waitFor((m) => m.t === 'reveal' && m.round === round, 18000)
    check(`A: round ${round} reveal carries the word`, reveal?.word === word && reveal.skipped === false, JSON.stringify(reveal))
    check(`A: round ${round} the non-drawer saw no word before the reveal`,
      !other.json().some((m) => m.t !== 'reveal' && m.round === round && JSON.stringify(m).includes(word)),
      JSON.stringify(other.json().filter((m) => m.t !== 'reveal' && m.round === round)))
    check(`A: round ${round} public state never carried the word`,
      !drawerConn.json().some((m) => m.t === 'state' && m.round === round && JSON.stringify(m).includes(word)))

    const scores = await drawerConn.waitFor((m) => m.t === 'state' && m.phase === 'scores' && m.round === round, 6000)
    check(`A: round ${round} goes to scores`, !!scores)
    check(`A: round ${round} scores frame is empty in step 2`,
      JSON.stringify(scores?.scores) === '{}' && scores?.correct?.length === 0)

    if (round === 1) {
      // Late join at the round 2 pick (wait for the transition first, so the
      // join snapshot is the new round, not the one being cleared).
      const pick2 = await a.waitFor((m) => m.t === 'state' && m.round === 2 && m.phase === 'pick', 12000)
      check('A: round 2 pick was announced before the late join', !!pick2, JSON.stringify(pick2))
      const late = await connect(code, (await anonUser()).token)
      const ls = await late.waitFor((m) => m.t === 'state' && m.round === 2 && m.phase === 'pick', 5000)
      check('A: a late joiner is a spectator (not the drawer)',
        !!ls && late.welcome?.seat === 2)
      const snap = await late.waitFor((m) => m.t === 'snapshot', 3000)
      check('A: round 2 starts with a cleared snapshot',
        snap?.round === 2 && snap?.strokes?.length === 0, JSON.stringify(snap))
      check('A: the late joiner got state before snapshot',
        late.json().map((m) => m.t).indexOf('state') < late.json().map((m) => m.t).indexOf('snapshot'))
      check('A: the late joiner got no secret frames',
        !late.json().some((m) => m.t === 'word_pick' || m.t === 'your_word' ||
          (m.t !== 'reveal' && JSON.stringify(m).includes(wordSeen ?? '\u0000'))))
      await late.close()
    }
  }

  const over = await a.waitFor((m) => m.t === 'state' && m.phase === 'game_over', 12000)
  check('A: after six rounds the game is over', !!over, JSON.stringify(over))
  const lobby = await a.waitFor((m) => m.t === 'state' && m.phase === 'lobby', 12000)
  check('A: game over returns to the lobby', !!lobby && lobby.rounds === 0, JSON.stringify(lobby))
  check('A: the lobby state has no secrets', lobby?.wordLen === null && lobby?.hint === null && lobby?.drawer === null)
  check('A: rotation drew every player three times', new Set(drawerByRound).size === 2 && drawerByRound.length === 6)
  await closeAll(conns)
}

// ===========================================================================
// B. Drawer disconnect: grace expires -> skipped reveal.
// ===========================================================================
{
  const { conns } = await roomWith(2)
  const [a, b] = conns
  a.ws.send(start)
  const st = await a.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  const wordPick = await a.waitFor((m) => m.t === 'word_pick' && m.round === 1, 5000)
  check('B: game started and the drawer has options', !!st && !!wordPick)
  a.ws.send(pick(0))
  const drawing = await a.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  check('B: drawing started before the disconnect', !!drawing)
  const word = wordPick?.options?.[0] ?? null
  await a.close() // the drawer vanishes
  // Wait on the event, not a fixed duration: the offer to skip fires after the
  // drawer grace, but a bug that misses the grace falls through to the round's
  // own timeout. Give it room for both, then assert the *reason* — skipped must
  // be true, so a timeout reveal is a real failure rather than a flaky timeout.
  const rev = await b.waitFor((m) => m.t === 'reveal' && m.round === 1, 25000)
  check('B: the absent drawer skips the round (~3 s grace)', !!rev && rev.skipped === true, JSON.stringify(rev))
  check('B: the already-chosen word is revealed', rev?.word === word, JSON.stringify({ rev: rev?.word, word }))
  check('B: the non-drawer never got a secret frame',
    !b.json().some((m) => m.t === 'word_pick' || m.t === 'your_word'))
  await b.close()
}

// ===========================================================================
// C. Drawer reconnect inside the grace window resumes the round.
// ===========================================================================
{
  const { code, users, conns } = await roomWith(2)
  const [a, b] = conns
  a.ws.send(start)
  await a.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  const wordPick = await a.waitFor((m) => m.t === 'word_pick' && m.round === 1, 5000)
  const word = wordPick?.options?.[0] ?? null
  a.ws.send(pick(0))
  await a.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  await a.close()
  await sleep(1000)
  const back = await connect(code, users[0].token) // the same drawer, inside the 3 s grace
  const your = await back.waitFor((m) => m.t === 'your_word' && m.round === 1, 5000)
  check('C: the drawer reconnect receives its word again', your?.word === word, JSON.stringify(your))
  check('C: the reconnect order is welcome, state, snapshot, your_word',
    back.json().slice(0, 4).map((m) => m.t).join(',') === 'welcome,state,snapshot,your_word',
    JSON.stringify(back.json().slice(0, 5).map((m) => m.t)))
  const resumed = await back.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 3000)
  check('C: the round is still drawing after the reconnect', resumed?.remainingMs > 0, JSON.stringify(resumed))
  await sleep(3500)
  check('C: the round did not skip (drawer reconnect cleared the grace)',
    !b.json().some((m) => m.t === 'reveal' && m.round === 1), JSON.stringify(b.json().filter((m) => m.t === 'reveal')))
  await back.close()
  await b.close()
}

// ===========================================================================
// D. Too few seats: a player leaves, the held seat expires, the game aborts.
// ===========================================================================
{
  const { conns } = await roomWith(2)
  const [a, b] = conns
  a.ws.send(start)
  await a.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  await a.waitFor((m) => m.t === 'word_pick', 5000)
  a.ws.send(pick(0))
  await a.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  await b.close() // the non-drawer leaves; its seat is held for 5 s (dev)
  const lobby = await a.waitFor((m) => m.t === 'state' && m.phase === 'lobby', 14000)
  check('D: below two seats the game aborts to the lobby', !!lobby, JSON.stringify(lobby))
  check('D: the aborted game drops the secret', lobby?.wordLen === null && lobby?.hint === null && lobby?.rounds === 0)
  await a.close()
}

// ===========================================================================
// E. Kick the drawer: the released seat skips the round immediately (no
//    grace wait), kicked socket 4003.
// ===========================================================================
{
  const { users, conns } = await roomWith(3)
  const [host, p2, p3] = conns
  host.ws.send(start)
  const first = await host.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === 1, 8000)
  check('E: three seats start a 6-round game', first?.rounds === 6, String(first?.rounds))
  await host.waitFor((m) => m.t === 'word_pick' && m.round === 1, 5000)
  host.ws.send(pick(0))
  await host.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.round === 1, 5000)
  const round2 = await host.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === 2, 25000)
  check('E: round 2 is drawn by the second seat', round2?.drawer === users[1].userId, JSON.stringify(round2?.drawer))
  host.ws.send(kick(users[1].userId))
  const ack = await host.waitFor((m) => m.t === 'kick_ack' && m.userId === users[1].userId, 5000)
  check('E: the host kicked the round-2 drawer', !!ack)
  const closed = await p2.waitForClose(4003, 5000)
  check('E: the kicked drawer socket closes 4003', !!closed, JSON.stringify(p2.closes))
  const rev = await host.waitFor((m) => m.t === 'reveal' && m.round === 2, 10000)
  check('E: the kicked drawer\'s released seat skips the round immediately',
    !!rev && rev.skipped === true && rev.word === null, JSON.stringify(rev))
  check('E: the remaining players never saw the drawer options',
    !p3.json().some((m) => m.t === 'word_pick' || m.t === 'your_word'))
  await host.close()
  await p3.close()
}

// ===========================================================================
// F. Only the current drawer may paint, and only while drawing. A stroke from
//    anyone else (or in another phase) is silently ignored: no relay, no
//    store, and it still counts against the sender's message budget.
// ===========================================================================
{
  const { users, conns } = await roomWith(2)
  const [host, peer] = conns
  host.ws.send(start)
  const firstPick = await host.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === 1, 8000)
  const drawer = firstPick?.drawer === users[0].userId ? host : peer
  const helper = drawer === host ? peer : host
  await drawer.waitFor((m) => m.t === 'word_pick' && m.round === 1, 5000)

  // During pick nobody may paint.
  const beforePick = helper.json().length
  drawer.ws.send(strokeFrames('p', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').start)
  await sleep(300)
  check('F: a stroke during pick is ignored',
    !helper.json().slice(beforePick).some((m) => m.t === 'stroke_start'))

  drawer.ws.send(pick(0))
  await drawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing' && m.round === 1, 5000)

  // The non-drawer paints: ignored.
  const before = helper.json().length
  helper.ws.send(strokeFrames('n', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').start)
  helper.ws.send(strokeFrames('n', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').end)
  await sleep(400)
  check('F: a non-drawer stroke is never relayed',
    !helper.json().slice(before).some((m) => m.t === 'stroke_start' || m.t === 'stroke_end'))
  check('F: the non-drawer stays connected (ignored, not punished)', !helper.closed)

  // The drawer paints: relayed to the other side.
  helper.messages.length = 0
  const f = strokeFrames('d', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  drawer.ws.send(f.start)
  drawer.ws.send(f.points)
  drawer.ws.send(f.end)
  const relayed = await helper.waitFor((m) => m.t === 'stroke_end', 4000)
  check('F: the drawer\'s stroke is relayed', !!relayed, JSON.stringify(helper.json().slice(-3)))

  await host.close()
  await peer.close()
}

// ===========================================================================
// G. Free draw in the lobby. With no game running the room is a canvas: a
//    lobby stroke reaches the other player live and is stored (a late joiner's
//    lobby snapshot contains it). Starting a game must clear that canvas:
//    round 1 begins blank and unflagged, and its caps are untouched.
// ===========================================================================
{
  const { users, conns, code } = await roomWith(2)
  const [host, peer] = conns

  // Everyone may draw in the lobby (free-draw canvas, not a dead room). The
  // other player sees it live, and a late joiner's snapshot contains it.
  const first = strokeFrames('l1', '11111111-1111-4111-8111-111111111111')
  host.ws.send(first.start)
  host.ws.send(first.end)
  const liveBring = await peer.waitFor(
    (m) => m.t === 'stroke_end' && m.stroke?.id === '11111111-1111-4111-8111-111111111111', 3000,
  ).catch(() => null)
  check('G: a lobby stroke is relayed live to the other player', !!liveBring)

  const lateUser = await anonUser()
  const late = await connect(code, lateUser.token)
  const lobbySnap = await late.waitFor(
    (m) => m.t === 'snapshot' && m.strokes.some((s) => s.id === '11111111-1111-4111-8111-111111111111'), 3000,
  ).catch(() => null)
  check('G: a lobby stroke is stored and appears in a late joiner lobby snapshot', !!lobbySnap,
    JSON.stringify(lobbySnap?.strokes?.map((s) => s.id)))
  await late.close()

  // Start the game. handleStart clears the lobby prefix before startGame
  // resets the round state, so round 1 is blank and unflagged.
  host.ws.send(start)
  const round1 = await host.waitFor((m) => m.t === 'state' && m.phase === 'pick' && m.round === 1, 8000)
  check('G: the game started at round 1', !!round1)

  const round1LateUser = await anonUser()
  const round1Late = await connect(code, round1LateUser.token)
  const round1Snap = await round1Late.waitFor((m) => m.t === 'snapshot' && m.round === 1, 4000)
  check('G: round 1 starts blank (lobby strokes cleared)',
    !!round1Snap && round1Snap.strokes.length === 0, JSON.stringify(round1Snap?.strokes))
  check('G: round 1 is not partial from lobby strokes', round1Snap?.partial === false,
    JSON.stringify(round1Snap?.partial))
  await round1Late.close()

  // Round 1's caps are fresh: the drawer can still store a stroke, and a late
  // joiner sees it in the round-1 snapshot.
  const drawer = round1?.drawer === users[0].userId ? host : peer
  const other = drawer === host ? peer : host
  await drawer.waitFor((m) => m.t === 'word_pick' && m.round === 1, 5000)
  drawer.ws.send(pick(0))
  await drawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)
  const d = strokeFrames('d', '44444444-4444-4444-8444-444444444444')
  drawer.ws.send(d.start)
  drawer.ws.send(d.end)
  const relayed = await other.waitFor((m) => m.t === 'stroke_end' && m.stroke?.id === '44444444-4444-4444-8444-444444444444', 4000)
  check('G: round 1 accepts a fresh drawer stroke after the lobby strokes', !!relayed,
    JSON.stringify(other.json().slice(-3)))

  await closeAll(conns)
}

// ===========================================================================
// H. Guessing (v2 Phase 3 step 4a): a live correct guess, the private wrong
//    feedback, and the per-user cap surviving a reconnect while the DO is
//    still awake (in-memory counter, no eviction).
// ===========================================================================
{
  const { users, conns, code } = await roomWith(2)
  const [host, peer] = conns

  host.ws.send(start)
  const pickState = await host.waitFor((m) => m.t === 'state' && m.phase === 'pick', 8000)
  check('H: two seats start a game', !!pickState)
  const drawer = pickState?.drawer === users[0].userId ? host : peer
  const guesser = drawer === host ? peer : host
  const wp = await drawer.waitFor((m) => m.t === 'word_pick', 5000)
  const word = wp?.options?.[0] ?? null
  check('H: the drawer has a word to pick', typeof word === 'string' && word.length > 0)
  drawer.ws.send(pick(0))
  await drawer.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 5000)

  // A wrong guess: private ack, not close, generic (the word is 6+ letters, so
  // a distant string is never "close").
  guesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: 'qqqqqqqqqq' }))
  const wrong = await guesser.waitFor((m) => m.t === 'guess_ack' && m.ok === false, 4000)
  check('H: a wrong guess acks privately with close=false',
    wrong?.ok === false && wrong?.close === false, JSON.stringify(wrong))

  // Drive the guesser to one below the cap across a reconnect: send 4 (inside
  // the burst), drop the socket, reconnect before the 5 s seat hold expires,
  // then send the rest. If the in-memory count survived, the cap still lands on
  // the same round-crossing guess number.
  const CAP = 20
  const paceMs = 550
  for (let i = 0; i < 4; i++) guesser.ws.send(JSON.stringify({ v: 1, t: 'guess', text: `nope${i}` }))
  await sleep(120)
  await guesser.close()
  const back = await connect(code, users[conns.indexOf(guesser)].token)
  const backSeat = back.welcome?.seat
  check('H: the reconnect reclaims the same seat', backSeat === guesser.welcome?.seat,
    `${backSeat} vs ${guesser.welcome?.seat}`)
  await back.waitFor((m) => m.t === 'state' && m.phase === 'drawing', 4000).catch(() => null)
  // 4 sent pre-reconnect; 16 more reaches 20 (all accepted), the 21st is the cap.
  let capErr = false
  for (let i = 4; i < CAP + 1; i++) {
    await sleep(paceMs)
    back.ws.send(JSON.stringify({ v: 1, t: 'guess', text: `nope${i}` }))
    const hit = back.json().find((m) => m.t === 'error' && m.reason === 'guess_cap')
    if (hit) { capErr = true; break }
  }
  check('H: the in-memory guess count survives a reconnect (cap still lands)',
    capErr, JSON.stringify(back.json().slice(-3)))
  check('H: the capped guesser is never closed', !back.closed)

  await closeAll([host, peer])
  await back.close()
}

summary('game-live')
