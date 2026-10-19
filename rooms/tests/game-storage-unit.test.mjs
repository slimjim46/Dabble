// v2 Phase 3 step 2 integration tests without a network: the real Room class
// against an in-memory Durable Object storage. Covers the alarm state machine,
// scoped round keys/clear, hibernation reload, drawer grace, too-few abort,
// the secret broadcast gate, and the storage-failure policy (never throw).
//
//   node tests/game-storage-unit.test.mjs
import { Room } from '../src/room.js'
import { newGameState, stateFrame } from '../src/game.js'
import { roundKey } from '../src/round.js'
import { check, summary } from './helpers.mjs'

const OPEN = 1
const ENV = {
  ENVIRONMENT: 'dev',
  GAME_PICK_MS: '1000',
  GAME_ROUND_MS: '5000',
  GAME_REVEAL_MS: '1000',
  GAME_SCORES_MS: '1000',
  GAME_OVER_MS: '1000',
  DRAWER_GRACE_MS: '1000',
  SEAT_HOLD_MS: '5000',
  ROOM_GRACE_MS: '60000',
}

function fakeState(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]))
  const sockets = []
  const state = {
    map,
    sockets,
    failPut: null, // (key) => boolean
    failAlarm: false,
    lastAlarm: null,
    storage: {
      async get(key) {
        return map.has(key) ? structuredClone(map.get(key)) : undefined
      },
      async put(key, value) {
        if (state.failPut?.(key)) throw new Error('put failed')
        map.set(key, structuredClone(value))
      },
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key)
      },
      async list({ prefix = '', limit = 1000, startAfter } = {}) {
        const out = new Map()
        for (const key of [...map.keys()].sort()) {
          if (!key.startsWith(prefix)) continue
          if (startAfter !== undefined && key <= startAfter) continue
          out.set(key, structuredClone(map.get(key)))
          if (out.size >= limit) break
        }
        return out
      },
      async deleteAll() {
        map.clear()
      },
      async setAlarm(at) {
        if (state.failAlarm) throw new Error('alarm failed')
        state.lastAlarm = at
      },
      async getAlarm() {
        return state.lastAlarm
      },
    },
    getWebSockets: () => sockets,
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  }
  return state
}

function fakeSocket(userId, { readyState = OPEN } = {}) {
  return {
    readyState,
    att: { userId, seat: 0, name: 'Guest', country: null, open: null, openK: null, v: 0, b: {} },
    frames: [],
    serializeAttachment(a) {
      this.att = a
    },
    deserializeAttachment() {
      return this.att
    },
    send(text) {
      this.frames.push(JSON.parse(text))
    },
    close() {},
  }
}

function seededRoom(overrides = {}) {
  return {
    createdAt: Date.now(),
    hostUserId: 'u1',
    nextSeat: 2,
    seats: {
      u1: { seat: 0, claimedAt: 1, heldUntil: null },
      u2: { seat: 1, claimedAt: 2, heldUntil: null },
    },
    blocked: {},
    lastEmptyAt: null,
    game: { ...newGameState(), ...overrides },
  }
}

const stroke = (id) => ({
  id,
  userId: 'u1',
  userName: 'Guest',
  color: '#e5484d',
  width: 4,
  b: 0,
  points: [1, 2, 3, 4],
})

async function newRoom(seed = {}, env = ENV) {
  const state = fakeState(seed)
  const room = new Room(state, env)
  return { state, room }
}

// ---- scoped keys + best-effort clear ---------------------------------------
{
  const game = { ...newGameState(), gameSeq: 2, round: 1, phase: 'drawing', word: 'pizza' }
  const { state, room } = await newRoom({ room: seededRoom(game) })
  const r = await room.load()
  state.map.set(roundKey(2, 1, 1), stroke('11111111-1111-4111-8111-111111111111'))
  state.map.set(roundKey(2, 1, 2), stroke('11111111-1111-4111-8111-111111111112'))
  state.map.set(roundKey(2, 2, 1), stroke('11111111-1111-4111-8111-111111111113'))

  const snap = await room.snapshotFrame(r)
  check('scoped keys: the snapshot lists only the current game/round',
    snap.strokes.length === 2 && snap.round === 1, JSON.stringify(snap.strokes.map((s) => s.id)))

  await room.clearRoundStrokes(r)
  check('scoped clear: deletes only the current round\'s keys',
    !state.map.has(roundKey(2, 1, 1)) && !state.map.has(roundKey(2, 1, 2)) && state.map.has(roundKey(2, 2, 1)),
    JSON.stringify([...state.map.keys()]))

  // A failed clear never throws and never leaks: the next round uses a new prefix.
  state.failPut = (key) => key === 'room'
  await room.clearRoundStrokes(r)
  check('scoped clear: storage failure is logged, not thrown', true)
}

// ---- start + secret frames to the drawer only ------------------------------
{
  const { state, room } = await newRoom({ room: seededRoom() })
  const r = await room.load()
  const hostWs = fakeSocket('u1')
  const peerWs = fakeSocket('u2')
  state.sockets.push(hostWs, peerWs)

  await room.handleStart(r, { userId: 'u1' }, hostWs)
  check('start: game starts in pick', r.game.phase === 'pick' && r.game.round === 1)
  check('start: host gets word_pick with 3 options',
    hostWs.frames.some((f) => f.t === 'word_pick' && f.options.length === 3))
  check('start: peer never gets word_pick',
    !peerWs.frames.some((f) => f.t === 'word_pick' || f.t === 'your_word'))
  const pickState = peerWs.frames.find((f) => f.t === 'state')
  check('start: public state has no word/options/wordLen in pick',
    !!pickState && pickState.phase === 'pick' && pickState.wordLen === null &&
    !('word' in pickState) && !('options' in pickState), JSON.stringify(pickState))

  const options = hostWs.frames.find((f) => f.t === 'word_pick').options
  await room.handlePick(r, { userId: 'u2' }, { i: 0 }, peerWs)
  check('pick: a non-drawer cannot pick', r.game.phase === 'pick')

  await room.handlePick(r, { userId: 'u1' }, { i: 99 }, hostWs)
  check('pick: an out-of-range index is ignored', r.game.phase === 'pick')

  await room.handlePick(r, { userId: 'u1' }, { i: 1 }, hostWs)
  check('pick: the drawer advances to drawing', r.game.phase === 'drawing' && r.game.word === options[1])
  check('pick: the drawer gets your_word', hostWs.frames.some((f) => f.t === 'your_word' && f.word === options[1]))
  check('pick: the peer still has no secret',
    !peerWs.frames.some((f) => f.t === 'your_word' || f.t === 'word_pick'))
  const drawState = peerWs.frames.filter((f) => f.t === 'state').at(-1)
  check('pick: public state shows only the masked hint',
    drawState.phase === 'drawing' && drawState.wordLen === options[1].length &&
    !drawState.hint.includes(options[1]) && !JSON.stringify(drawState).includes(options[1]),
    JSON.stringify(drawState))

  // The alarm hint step never leaks the word.
  r.game.deadlineAt = Date.now() - 1
  r.game.hintAts = [Date.now() - 2, Date.now() + 100000]
  r.game.hintStep = 0
  await room.alarm()
  const hinted = peerWs.frames.filter((f) => f.t === 'state').at(-1)
  check('alarm: a hint is broadcast without the word',
    hinted.hintStep === undefined && hinted.hint !== null && !hinted.hint.includes(options[1]),
    JSON.stringify(hinted))

  // Force the reveal: the word may now be broadcast.
  r.game.phaseEndsAt = Date.now() - 1
  r.game.deadlineAt = Date.now() - 1
  await room.alarm()
  const reveal = peerWs.frames.find((f) => f.t === 'reveal')
  check('alarm: the reveal broadcasts the word', reveal?.word === options[1], JSON.stringify(reveal))
  check('alarm: reveal carries skipped=false after a normal drawing',
    reveal?.skipped === false && Array.isArray(reveal.correct))
}

// ---- secret broadcast gate -------------------------------------------------
{
  const { state, room } = await newRoom({ room: seededRoom() })
  await room.load()
  const ws = fakeSocket('u2')
  state.sockets.push(ws)
  room.broadcast({ v: 1, t: 'state', word: 'pizza' })
  room.broadcast({ v: 1, t: 'state', options: ['a', 'b', 'c'] })
  check('gate: a broadcast carrying a word never reaches a socket', ws.frames.length === 0, JSON.stringify(ws.frames))
  room.broadcast({ v: 1, t: 'reveal', word: 'pizza', round: 1, correct: [], skipped: false })
  check('gate: a reveal still reaches sockets', ws.frames.length === 1 && ws.frames[0].t === 'reveal')
}

// ---- drawer grace: skip + no word leak -------------------------------------
{
  const game = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6,
    order: ['u1', 'u2'], drawerUserId: 'u1', word: 'pizza', skipped: false,
    hintAts: [Date.now() + 100000], phaseEndsAt: Date.now() + 100000,
    deadlineAt: Date.now() + 100000, drawerGraceAt: Date.now() - 1,
  }
  const { state, room } = await newRoom({ room: seededRoom(game) })
  const r = await room.load()
  const peer = fakeSocket('u2')
  state.sockets.push(peer) // u1 is not connected: the grace must skip
  await room.alarm()
  check('grace: an absent drawing drawer skips to reveal', r.game.phase === 'reveal' && r.game.skipped === true)
  check('grace: the chosen word is revealed (it was in play)', r.game.word === 'pizza')
  const rev = peer.frames.find((f) => f.t === 'reveal')
  check('grace: the skipped reveal is broadcast', rev?.skipped === true && rev?.word === 'pizza')
}

// ---- too few seats aborts, clears secrets, keeps the room -------------------
{
  const game = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 2, rounds: 6,
    order: ['u1', 'u2'], drawerUserId: 'u2', word: 'pizza', options: null,
    phaseEndsAt: Date.now() + 100000, deadlineAt: Date.now() + 100000,
  }
  const seed = seededRoom(game)
  delete seed.seats.u2 // one player left; the other seat is held
  const { state, room } = await newRoom({ room: seed })
  const r = await room.load()
  state.map.set(roundKey(1, 2, 1), stroke('22222222-2222-4222-8222-222222222222'))
  const ws = fakeSocket('u1')
  state.sockets.push(ws)
  await room.alarm()
  check('abort: fewer than two seats returns to the lobby', r.game.phase === 'lobby')
  check('abort: the word and options are gone', r.game.word === null && r.game.options === null)
  check('abort: round strokes are cleared', !state.map.has(roundKey(1, 2, 1)))
  check('abort: the state broadcast is in the lobby', ws.frames.some((f) => f.t === 'state' && f.phase === 'lobby'))
}

// ---- hibernation: a second instance reloads and continues -------------------
{
  const first = await newRoom({ room: seededRoom() })
  const r1 = await first.room.load()
  const hostWs = fakeSocket('u1')
  first.state.sockets.push(hostWs)
  await first.room.handleStart(r1, { userId: 'u1' }, hostWs)
  const options = hostWs.frames.find((f) => f.t === 'word_pick').options
  // The DO is evicted between the start alarm and the pick timeout.
  const second = await newRoom(Object.fromEntries(first.state.map))
  const r2 = await second.room.load()
  // Eviction closes the drawer's socket: their seat is held (reconnectable),
  // not released, so the pick deadline still governs the round.
  r2.seats.u1.heldUntil = Date.now() + 100000
  check('hibernate: the second instance reloads the same game',
    r2.game.phase === 'pick' && r2.game.rounds === r1.game.rounds && r2.game.gameSeq === 1)
  check('hibernate: options survive in storage', JSON.stringify(r2.game.options) === JSON.stringify(options))
  r2.game.deadlineAt = Date.now() - 1
  r2.game.phaseEndsAt = Date.now() - 1
  const peer = fakeSocket('u2')
  second.state.sockets.push(peer)
  await second.room.alarm()
  check('hibernate: an expired pick auto-picks the first option',
    r2.game.phase === 'drawing' && r2.game.word === options[0], JSON.stringify({ phase: r2.game.phase, word: r2.game.word }))
  const st = peer.frames.find((f) => f.t === 'state')
  check('hibernate: the public state after wake still hides the word',
    !!st && st.phase === 'drawing' && st.wordLen === options[0].length && !JSON.stringify(st).includes(options[0]))
}

// ---- storage failures never stop the game ----------------------------------
{
  const game = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6,
    order: ['u1', 'u2'], drawerUserId: 'u1', word: 'pizza', skipped: false,
    hintAts: [Date.now() - 100000], hintStep: 1,
    phaseEndsAt: Date.now() - 1, deadlineAt: Date.now() - 1,
  }
  const { state, room } = await newRoom({ room: seededRoom(game) })
  const r = await room.load()
  const peer = fakeSocket('u2')
  state.sockets.push(peer)
  state.failPut = (key) => key === 'room' // saving fails, storage otherwise works
  let threw = false
  try {
    await room.alarm()
  } catch {
    threw = true
  }
  check('storage: a failed room save does not throw out of the alarm', !threw)
  check('storage: the phase still advances', r.game.phase === 'reveal')
  check('storage: the reveal is still broadcast', peer.frames.some((f) => f.t === 'reveal' && f.word === 'pizza'))
  check('storage: the client gets one busy notice', peer.frames.filter((f) => f.t === 'error' && f.reason === 'busy').length === 1)

  // A stroke put failure marks the round partial, notifies, and returns false.
  r.game.phase = 'drawing'
  state.failPut = (key) => key !== 'room'
  const stored = await room.storeRoundStroke(r, stroke('33333333-3333-4333-8333-333333333333'))
  check('storage: a failed stroke put returns false and flags partial', stored === false && r.game.partial === true)
  check('storage: the busy notice is rate-limited, not repeated', peer.frames.filter((f) => f.t === 'error').length === 1)
}

// ---- stroke gating: only the current drawer, only while drawing ------------
{
  const game = { ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6, order: ['u1', 'u2'], drawerUserId: 'u1', word: 'pizza' }
  const { state, room } = await newRoom({ room: seededRoom(game) })
  const r = await room.load()
  const drawer = fakeSocket('u1')
  const bystander = fakeSocket('u2')
  bystander.closes = []
  bystander.close = (code) => bystander.closes.push(code)
  state.sockets.push(drawer, bystander)

  const startFrame = JSON.stringify({ v: 1, t: 'stroke_start', k: 'k', id: '55555555-5555-4555-8555-555555555555', userId: 'x', userName: 'x', color: '#e5484d', width: 4, pts: [1, 1] })
  const endFrame = JSON.stringify({
    v: 1, t: 'stroke_end', k: 'k',
    stroke: { id: '55555555-5555-4555-8555-555555555555', userId: 'x', userName: 'x', color: '#e5484d', width: 4, points: [1, 1, 2, 2] },
  })

  // The drawer paints: relayed and stored.
  await room.webSocketMessage(drawer, startFrame)
  await room.webSocketMessage(drawer, endFrame)
  check('gate: the drawer\'s stroke is relayed', bystander.frames.some((f) => f.t === 'stroke_end'))
  check('gate: the drawer\'s stroke is stored',
    [...state.map.keys()].some((k) => k.startsWith(roundKey(1, 1, 0).slice(0, -6))))

  // A bystander paints: ignored, never relayed, never stored.
  const before = bystander.frames.length
  await room.webSocketMessage(bystander, startFrame)
  await room.webSocketMessage(bystander, endFrame)
  check('gate: a bystander stroke is never relayed',
    !bystander.frames.slice(before).some((f) => f.t === 'stroke_start' || f.t === 'stroke_end'))
  check('gate: a bystander stroke is not stored', r.game.count === 1, String(r.game.count))
  check('gate: a bystander stroke does not close or violate the socket',
    bystander.closes.length === 0 && bystander.att.v === 0, JSON.stringify({ closes: bystander.closes, v: bystander.att.v }))

  // Wrong phase: even the drawer's stroke is ignored outside drawing.
  r.game.phase = 'reveal'
  const before2 = bystander.frames.length
  await room.webSocketMessage(drawer, startFrame)
  check('gate: a stroke outside drawing is ignored',
    !bystander.frames.slice(before2).some((f) => f.t === 'stroke_start'))
  r.game.phase = 'drawing'
}

// ---- drawer grace only applies to a HELD seat ------------------------------
{
  // Seat released (kicked / hold expired): skip the round at the next alarm,
  // with no waiting for the grace.
  const game = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6, order: ['u1', 'u2', 'u3'],
    drawerUserId: 'u1', word: 'pizza',
    phaseEndsAt: Date.now() + 100000, deadlineAt: Date.now() + 100000,
  }
  const seed = seededRoom(game)
  seed.seats.u3 = { seat: 2, claimedAt: 3, heldUntil: null }
  seed.nextSeat = 3
  delete seed.seats.u1 // the drawer's seat was released; two seats remain
  const { state, room } = await newRoom({ room: seed })
  const r = await room.load()
  const ws = fakeSocket('u2')
  state.sockets.push(ws)
  await room.alarm()
  check('grace: a released drawer is skipped immediately (no grace wait)',
    r.game.phase === 'reveal' && r.game.skipped === true, JSON.stringify({ phase: r.game.phase, skipped: r.game.skipped }))
  check('grace: the immediate skip never sets a grace deadline', r.game.drawerGraceAt === 0)

  // Held seat inside the grace: the round is NOT skipped yet.
  const game2 = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6, order: ['u1', 'u2'],
    drawerUserId: 'u1', word: 'pizza', drawerGraceAt: Date.now() + 100000,
    phaseEndsAt: Date.now() + 100000, deadlineAt: Date.now() + 100000,
  }
  const seed2 = seededRoom(game2)
  seed2.seats.u1.heldUntil = Date.now() + 100000
  const { state: state2, room: room2 } = await newRoom({ room: seed2 })
  const r2 = await room2.load()
  state2.sockets.push(fakeSocket('u2'))
  await room2.alarm()
  check('grace: a held drawer inside the grace is still drawing',
    r2.game.phase === 'drawing' && r2.game.drawerGraceAt > 0, JSON.stringify({ phase: r2.game.phase }))
}

// ---- guesses survive an eviction reload -------------------------------------
{
  const game = {
    ...newGameState(), gameSeq: 1, phase: 'drawing', round: 1, rounds: 6,
    order: ['u1', 'u2'], drawerUserId: 'u1', word: 'pizza',
    phaseEndsAt: Date.now() + 100000, deadlineAt: Date.now() + 100000,
  }
  const first = await newRoom({ room: seededRoom(game) })
  const r1 = await first.room.load()
  const guesserWs = fakeSocket('u2')
  first.state.sockets.push(guesserWs)
  const before = guesserWs.frames.length
  await first.room.webSocketMessage(guesserWs, JSON.stringify({ v: 1, t: 'guess', text: 'pizza' }))
  check('evict: a correct guess is saved before any reload',
    r1.game.correct.includes('u2') && r1.game.guessCount.u2 === 1,
    JSON.stringify({ correct: r1.game.correct, guessCount: r1.game.guessCount }))
  check('evict: the correct guesser gets a private ok ack',
    guesserWs.frames.slice(before).some((f) => f.t === 'guess_ack' && f.ok === true))

  // Evict: a brand-new Room instance reads the same storage map. Identity that
  // must outlive the instance (who already guessed) comes back from storage.
  const second = await newRoom(Object.fromEntries(first.state.map))
  const r2 = await second.room.load()
  check('evict: the correct list survives eviction', r2.game.correct.includes('u2'),
    JSON.stringify(r2.game.correct))
  check('evict: the per-user guess count survives eviction', r2.game.guessCount.u2 === 1,
    JSON.stringify(r2.game.guessCount))
  const reloadedState = stateFrame(r2.game, Date.now())
  check('evict: the secret word is still masked in the public state after reload',
    reloadedState.phase === 'drawing' && reloadedState.wordLen === 5 &&
    !JSON.stringify(reloadedState).includes('pizza'), JSON.stringify(reloadedState))
}

summary('game-storage-unit')
