// The room-load race, offline and deterministic.
//
// A socket's stroke_start and its stroke_end must not straddle the room load.
// webSocketMessage reads the connection attachment (src/room.js, the
// deserializeAttachment at the top of the handler) and writes it back (the
// serializeAttachment after the ownership check) with exactly one await in
// between: the room load, which is a storage read.
//
// If the second message of the same socket is handled while the first is
// still suspended on that read, the second handler holds the attachment copy
// it read BEFORE the first handler wrote the open-stroke slot. The ownership
// check then finds no open stroke, rejects the frame as a stroke_ownership
// violation, and the stroke is neither relayed nor stored: the sender sees
// nothing, the round loses a stroke, and the cap is never reached.
//
// The runtime serializes the attachment (serializeAttachment "keeps a copy",
// structured clone; modifications after the call are not retained), so a fake
// socket that shares one object between serialize and deserialize cannot
// show this. The fake below models the copy semantics.
//
// The same hazard has a second face: two sockets whose strokes end while the
// room is still loading each get their OWN copy of the room, so each claims
// round sequence number 1 and the second put overwrites the first stroke.
//
//   node tests/load-race-unit.test.mjs
import { Room } from '../src/room.js'
import { newGameState } from '../src/game.js'
import { roundKey } from '../src/round.js'
import { check, summary } from './helpers.mjs'

const OPEN = 1
const ENV = { ENVIRONMENT: 'dev', ROOM_GRACE_MS: '60000', SEAT_HOLD_MS: '5000' }

const ID_A = '0e0a0000-0000-4000-8000-0000000000a1'
const ID_B = '0e0a0000-0000-4000-8000-0000000000b1'

function seededRoom() {
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
    game: newGameState(),
  }
}

/** A latch the test opens: every read of 'room' waits for it. */
function latch() {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open: () => open() }
}

function fakeState(seedRoom, gate) {
  const map = new Map()
  if (seedRoom) map.set('room', structuredClone(seedRoom))
  const sockets = []
  const state = {
    map,
    sockets,
    roomReads: 0,
    storage: {
      async get(key) {
        if (key === 'room' && gate) {
          state.roomReads += 1
          return gate.promise.then(() => (map.has('room') ? structuredClone(map.get('room')) : undefined))
        }
        return map.has(key) ? structuredClone(map.get(key)) : undefined
      },
      async put(key, value) {
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
      async setAlarm() {},
      async getAlarm() {
        return null
      },
    },
    getWebSockets: () => sockets,
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  }
  return state
}

/** A socket whose attachment is a COPY, like the runtime's. */
function fakeSocket(userId, seat) {
  return {
    readyState: OPEN,
    att: { userId, seat, name: 'Guest', country: null, open: null, openK: null, v: 0, b: {} },
    frames: [],
    closes: [],
    serializeAttachment(a) {
      this.att = structuredClone(a)
    },
    deserializeAttachment() {
      return structuredClone(this.att)
    },
    send(text) {
      this.frames.push(JSON.parse(text))
    },
    close(code, reason) {
      this.closes.push({ code, reason })
    },
  }
}

const startFrame = (id, k) =>
  JSON.stringify({ v: 1, t: 'stroke_start', k, id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, pts: [1, 1] })

const endFrame = (id, k) =>
  JSON.stringify({
    v: 1,
    t: 'stroke_end',
    k,
    stroke: { id, userId: 'x', userName: 'x', color: '#e5484d', width: 4, points: [1, 1, 2, 2] },
  })

// 1. One socket: stroke_start and stroke_end must not straddle the room load.
{
  const gate = latch()
  const state = fakeState(seededRoom(), gate)
  const room = new Room(state, ENV)
  const artist = fakeSocket('u1', 0)
  const watcher = fakeSocket('u2', 1)
  state.sockets.push(artist, watcher)

  // Both frames are in flight while the room is still loading: the first
  // handler is suspended on the storage read when the second one arrives.
  const p1 = room.webSocketMessage(artist, startFrame(ID_A, 'k1'))
  const p2 = room.webSocketMessage(artist, endFrame(ID_A, 'k1'))
  gate.open()
  await Promise.all([p1, p2])

  const ends = watcher.frames.filter((m) => m.t === 'stroke_end')
  check('race: the stroke_end of a stroke that straddled the load is relayed', ends.length === 1, JSON.stringify(ends.length))
  const stored = [...state.map.entries()].filter(([k]) => k.startsWith('rs:'))
  check('race: the stroke that straddled the load is stored', stored.length === 1, JSON.stringify(stored.map(([k]) => k)))
  check('race: no ownership violation was recorded', artist.att.v === 0, `v=${artist.att.v}`)
  check('race: the open-stroke slot is released', artist.att.open === null, JSON.stringify(artist.att.open))
  check('race: the socket was not closed', artist.closes.length === 0, JSON.stringify(artist.closes))
}

// 2. Two sockets: strokes that end while the room loads must not fork the
//    round sequence. Both handlers find the room unloaded, so each loads its
//    OWN copy of it, and each claims round sequence number 1 in its copy:
//    the second put overwrites the first stroke under the same key.
//    The open-stroke slot is pre-set here, so this case isolates the room
//    copy from the attachment straddle of case 1.
{
  const gate = latch()
  const state = fakeState(seededRoom(), gate)
  const room = new Room(state, ENV)
  const a = fakeSocket('u1', 0)
  const b = fakeSocket('u2', 1)
  const watcher = fakeSocket('u3', 2)
  a.att.open = ID_A
  b.att.open = ID_B
  state.sockets.push(a, b, watcher)

  const p1 = room.webSocketMessage(a, endFrame(ID_A, 'k1'))
  const p2 = room.webSocketMessage(b, endFrame(ID_B, 'k2'))
  gate.open()
  await Promise.all([p1, p2])

  const stored = [...state.map.entries()].filter(([k]) => k.startsWith('rs:')).map(([k]) => k).sort()
  const expected = [roundKey(0, 1, 1), roundKey(0, 1, 2)].sort()
  check('race: two concurrent strokes get distinct round keys', JSON.stringify(stored) === JSON.stringify(expected), JSON.stringify(stored))
  const ends = watcher.frames.filter((m) => m.t === 'stroke_end')
  check('race: both concurrent strokes are relayed', ends.length === 2, JSON.stringify(ends.length))
  check('race: the room is read from storage once per load', state.roomReads === 1, `reads=${state.roomReads}`)
}

summary('load-race-unit')
