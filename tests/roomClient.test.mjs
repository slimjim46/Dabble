// v2 Phase 2: the room client's half of the protocol, and the seams it shares
// with the plaza. Plain node, no framework, no network:
//   node tests/roomClient.test.mjs
//
// The room client lives in src/rooms/ and deliberately does NOT import
// rooms/src/wire.js at build time (rooms/ is a standalone Cloudflare project
// and src/ must not depend on it to build). Two copies of one protocol is a
// real risk, so this file imports the server's parsers directly and runs every
// message the client can produce through them: the copies cannot drift without
// a red test. Sections 13-14 guard the plaza's one approved change: the
// "Play with friends" link, which exists only where VITE_ROOMS_URL is set.
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { PAPER_SIZE as SERVER_PAPER_SIZE } from '../rooms/src/config.js'
import * as serverConfig from '../rooms/src/config.js'
import { CLIENT_TYPES, buildSnapshot, parseEnvelope } from '../rooms/src/wire.js'
import { acceptPick, advance, newGameState, revealFrame, startGame, stateFrame, wordPickFrame, yourWordFrame } from '../rooms/src/game.js'
import { MAX_NAME_LENGTH, PAPER_SIZE } from '../src/lib/constants.js'
import { roomsEntryHref } from '../src/lib/roomsEntry.js'
import { BRUSH_IDS, PALETTE, DEFAULT_COLOR, colorForKey } from '../src/lib/palette.js'
import { encodePoints, quantize } from '../src/lib/strokeCodec.js'
import { copyText } from '../src/rooms/roomsClipboard.js'
import { ROOM_ERROR_COPY, RETRYABLE_ERRORS, TRANSPORT_ONLY_ERRORS } from '../src/rooms/roomsErrors.js'
import {
  FATAL_CLOSE_CODES,
  MAX_RECONNECT_ATTEMPTS,
  MAX_ROUND_BYTES,
  MAX_ROUND_POINTS,
  MAX_ROUND_STROKES,
  MAX_WORD_LENGTH,
  MIN_PLAYERS,
  PHASES,
  ROOM_CODE_RE,
  ROOM_CURSOR_FLUSH_MS,
  ROOM_POINT_FLUSH_MS,
  WORD_OPTIONS,
  closeDisposition,
  fatalCloseError,
  isFatalClose,
  nextAfterClose,
  reconnectDelay,
} from '../src/rooms/roomsConfig.js'
import {
  MAX_KEY_LENGTH as CLIENT_MAX_KEY_LENGTH,
  MAX_STROKE_WIDTH as CLIENT_MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH as CLIENT_MIN_STROKE_WIDTH,
  WIRE_VERSION as CLIENT_WIRE_VERSION,
  cursorMessage,
  createRoom,
  encode,
  kickMessage,
  newRoomKey,
  newRoomStrokeId,
  parseRoomMessage,
  pickMessage,
  probeRoom,
  startMessage,
  strokeCancelMessage,
  strokeEndMessage,
  strokePointsMessage,
  strokeStartMessage,
} from '../src/rooms/roomsWire.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID2 = '22222222-3333-4444-5555-666666666666'

function readSource(rel) {
  return readFileSync(path.join(root, rel), 'utf8')
}

// ===========================================================================
// 1. Contract: every message the client can send passes the server's parser,
//    and the two type lists are exactly the same set.
// ===========================================================================
const sampleStroke = {
  id: UUID,
  userId: UUID2,
  userName: 'Swift Otter',
  color: DEFAULT_COLOR,
  width: 6,
  points: [
    { x: 0, y: 0 },
    { x: 10.25, y: 20.5 },
    { x: 300.4, y: 1999.9 },
  ],
}

const outbound = [
  // stroke_start carries exactly the first point of a stroke (two numbers);
  // RoomPaper pushes only that point before the transport sends it.
  ['stroke_start', strokeStartMessage('k1', { ...sampleStroke, points: [sampleStroke.points[0]] })],
  ['stroke_points', strokePointsMessage('k1', UUID, 1, encodePoints(sampleStroke.points))],
  ['stroke_end', strokeEndMessage('k1', sampleStroke)],
  ['stroke_cancel', strokeCancelMessage('k1', UUID)],
  ['cursor', cursorMessage('k1', 123.456, 789.012)],
  ['kick', kickMessage(UUID2)],
  ['start', startMessage()],
  ['pick', pickMessage(1)],
]

for (const [type, message] of outbound) {
  const text = encode(message)
  const env = parseEnvelope(text)
  check(`contract: ${type} survives the server's parseEnvelope`, !!env, text)
  const parser = CLIENT_TYPES[type]
  check(`contract: server knows how to parse ${type}`, typeof parser === 'function')
  if (!env || typeof parser !== 'function') continue
  const parsed = parser(env.p)
  check(`contract: server accepts the client's ${type}`, parsed !== null, JSON.stringify(parsed))
}

{
  const clientTypes = new Set(outbound.map(([type]) => type))
  const serverTypes = new Set(Object.keys(CLIENT_TYPES))
  const missingOnClient = [...serverTypes].filter((t) => !clientTypes.has(t))
  const missingOnServer = [...clientTypes].filter((t) => !serverTypes.has(t))
  check(
    'contract: client builders and server CLIENT_TYPES are the same set',
    missingOnClient.length === 0 && missingOnServer.length === 0,
    `server-only=${missingOnClient} client-only=${missingOnServer}`,
  )
}

{
  // The server must not let the client choose identity: it overwrites
  // userId/userName from the connection attachment. Nothing in the client's
  // builders may rely on the server forwarding them verbatim.
  const start = strokeStartMessage('k1', { ...sampleStroke, points: [sampleStroke.points[0]] })
  const env = parseEnvelope(encode(start))
  const parsed = CLIENT_TYPES.stroke_start(env.p)
  check(
    'contract: stroke_start is parseable without the server trusting identity',
    !!parsed && typeof parsed.userId === 'string' && parsed.userId.length > 0,
    JSON.stringify(parsed),
  )
}

{
  // The other direction of the mirror: a snapshot the server builds must pass
  // the client's own SERVER_TYPES parser (the client never sends snapshot).
  const built = buildSnapshot(1, false, [
    { id: UUID, userId: UUID2, userName: 'A', color: '#E5484D', width: 5, b: 0, points: [1, 2, 3, 4] },
    { id: UUID2, userId: UUID2, userName: 'B', color: '#123456', width: 5, b: 0, points: [1, 2] },
  ])
  const parsed = parseRoomMessage(JSON.stringify(built))
  check('contract: the server-built snapshot parses on the client',
    parsed?.type === 'snapshot' && parsed.data.round === 1 && parsed.data.partial === false,
    JSON.stringify(parsed))
  check('contract: the client canonicalises the snapshot stroke colour',
    parsed?.data?.strokes?.length === 1 && parsed.data.strokes[0].color === '#e5484d',
    JSON.stringify(parsed?.data?.strokes))
}

{
  // Game frames the server builds must pass the client's own parsers. The
  // secret word only ever appears in reveal / targeted drawer frames.
  const T = { pick: 10000, drawing: 60000, reveal: 8000, scores: 8000, gameOver: 30000, drawerGrace: 10000 }
  const game = startGame(newGameState(), [UUID, UUID2], 1000, T, ['pizza', 'robot', 'castle'])
  const state = parseRoomMessage(JSON.stringify(stateFrame(game, 2000)))
  check('contract: the server state frame parses on the client',
    state?.type === 'state' && state.data.phase === 'pick' && state.data.round === 1 && state.data.rounds === 6,
    JSON.stringify(state))
  check('contract: pick state carries no word (wordLen null)', state?.data?.wordLen === null && state.data.hint === null)
  const pickFrame = parseRoomMessage(JSON.stringify(wordPickFrame(game)))
  check('contract: word_pick parses with the exact option count',
    pickFrame?.type === 'word_pick' && pickFrame.data.options.length === WORD_OPTIONS, JSON.stringify(pickFrame))

  acceptPick(game, 2, 3000, T)
  const draw = parseRoomMessage(JSON.stringify(stateFrame(game, 4000)))
  check('contract: drawing state masks the word, exposes length',
    draw?.data?.phase === 'drawing' && draw.data.wordLen === 'castle'.length && draw.data.hint === '______' &&
    !JSON.stringify(draw).includes('castle'), JSON.stringify(draw))
  const your = parseRoomMessage(JSON.stringify(yourWordFrame(game)))
  check('contract: your_word parses (drawer only)', your?.type === 'your_word' && your.data.word === 'castle', JSON.stringify(your))

  const end = 3000 + T.drawing
  advance(game, end, T)
  const rev = parseRoomMessage(JSON.stringify(revealFrame(game)))
  check('contract: reveal parses and carries the public word',
    rev?.type === 'reveal' && rev.data.word === 'castle' && rev.data.skipped === false, JSON.stringify(rev))

  const busy = parseRoomMessage(JSON.stringify({ v: 1, t: 'error', reason: 'busy' }))
  check('contract: the busy error parses and has copy + retry',
    busy?.type === 'error' && busy.data.reason === 'busy' && !!ROOM_ERROR_COPY.busy && RETRYABLE_ERRORS.includes('busy'),
    JSON.stringify(busy))
}

// ===========================================================================
// 2. Palette drift: src/lib/palette.js <-> rooms/src/config.js <-> Toolbar.jsx
// ===========================================================================
{
  const same = JSON.stringify(PALETTE) === JSON.stringify(serverConfig.PALETTE)
  check('palette: client PALETTE equals server PALETTE (members and order)', same,
    `client=${JSON.stringify(PALETTE)} server=${JSON.stringify(serverConfig.PALETTE)}`)

  const src = readSource('src/components/Toolbar.jsx')
  const m = /const COLORS = \[([\s\S]*?)\n\]/.exec(src)
  const toolbar = m ? [...m[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((x) => x[1].toLowerCase()) : null
  check('palette: Toolbar.jsx COLORS parsed', Array.isArray(toolbar) && toolbar.length > 0, JSON.stringify(toolbar))
  check('palette: client PALETTE equals plaza Toolbar COLORS',
    Array.isArray(toolbar) && JSON.stringify(PALETTE) === JSON.stringify(toolbar),
    `palette=${JSON.stringify(PALETTE)} toolbar=${JSON.stringify(toolbar)}`)

  check('palette: no duplicates', new Set(PALETTE).size === PALETTE.length)
  check('palette: frozen', Object.isFrozen(PALETTE))
  check('palette: DEFAULT_COLOR is in PALETTE', PALETTE.includes(DEFAULT_COLOR))
  check('palette: colorForKey always returns a palette colour',
    PALETTE.includes(colorForKey('')) && PALETTE.includes(colorForKey(UUID2)) && PALETTE.includes(colorForKey(42)),
    `${colorForKey('')} ${colorForKey(UUID2)} ${colorForKey(42)}`)

  check('brush ids: client BRUSH_IDS equals server BRUSH_IDS',
    JSON.stringify(BRUSH_IDS) === JSON.stringify(serverConfig.BRUSH_IDS),
    `client=${JSON.stringify(BRUSH_IDS)} server=${JSON.stringify(serverConfig.BRUSH_IDS)}`)
}

// ===========================================================================
// 3. Shared constants between src/rooms/roomsConfig.js, roomsWire.js and
//    rooms/src/config.js — change one, change the other.
// ===========================================================================
{
  const pairs = [
    ['ROOM_CODE_RE', ROOM_CODE_RE.source, serverConfig.ROOM_CODE_RE.source],
    ['ROOM_CODE_RE flags', ROOM_CODE_RE.flags, serverConfig.ROOM_CODE_RE.flags],
    ['MAX_PLAYERS', 12, serverConfig.MAX_PLAYERS],
    ['MAX_LIVE_BATCH_NUMBERS', 400, serverConfig.MAX_LIVE_BATCH_NUMBERS],
    ['MAX_FINAL_POINT_NUMBERS', 8000, serverConfig.MAX_FINAL_POINT_NUMBERS],
    ['WIRE_VERSION', CLIENT_WIRE_VERSION, serverConfig.WIRE_VERSION],
    ['MIN_STROKE_WIDTH', CLIENT_MIN_STROKE_WIDTH, serverConfig.MIN_STROKE_WIDTH],
    ['MAX_STROKE_WIDTH', CLIENT_MAX_STROKE_WIDTH, serverConfig.MAX_STROKE_WIDTH],
    ['MAX_KEY_LENGTH', CLIENT_MAX_KEY_LENGTH, serverConfig.MAX_KEY_LENGTH],
    ['MAX_NAME_LENGTH', MAX_NAME_LENGTH, serverConfig.MAX_NAME_LENGTH],
    ['PAPER_SIZE', PAPER_SIZE, SERVER_PAPER_SIZE],
    ['MAX_ROUND_STROKES', MAX_ROUND_STROKES, serverConfig.MAX_ROUND_STROKES],
    ['MAX_ROUND_POINTS', MAX_ROUND_POINTS, serverConfig.MAX_ROUND_POINTS],
    ['MAX_ROUND_BYTES', MAX_ROUND_BYTES, serverConfig.MAX_ROUND_BYTES],
    ['MIN_PLAYERS', MIN_PLAYERS, serverConfig.MIN_PLAYERS],
    ['WORD_OPTIONS', WORD_OPTIONS, serverConfig.WORD_OPTIONS],
    ['MAX_WORD_LENGTH', MAX_WORD_LENGTH, serverConfig.MAX_WORD_LENGTH],
    ['PHASES', JSON.stringify(PHASES), JSON.stringify(serverConfig.PHASES)],
  ]
  for (const [label, a, b] of pairs) {
    check(`constants: ${label} matches the server`, a === b, `client=${a} server=${b}`)
  }

  check('constants: ROOM_CODE_RE rejects the look-alike characters',
    !ROOM_CODE_RE.test('00000') && !ROOM_CODE_RE.test('IIIII') && !ROOM_CODE_RE.test('LLLLL') &&
    !ROOM_CODE_RE.test('11111') && ROOM_CODE_RE.test('ABCDE') && ROOM_CODE_RE.test('Z2349'))
}

// ===========================================================================
// 4. Send budgets: the flush intervals must sit inside the server's
//    RATE_BUDGET, or the server closes the socket under normal drawing.
// ===========================================================================
{
  const budgetCases = [
    ['stroke_points', ROOM_POINT_FLUSH_MS],
    ['cursor', ROOM_CURSOR_FLUSH_MS],
  ]
  for (const [type, flushMs] of budgetCases) {
    const { perSec, burst } = serverConfig.RATE_BUDGET[type]
    const sustained = 1000 / flushMs
    check(`budget: ${type} sustained ${sustained}/s <= ${perSec}/s`, sustained <= perSec,
      `${sustained} vs ${perSec}`)
    // Headroom for timer drift: at least 20% under budget.
    check(`budget: ${type} keeps >=20% headroom`, perSec >= sustained * 1.2,
      `perSec=${perSec} sustained=${sustained}`)
    check(`budget: ${type} cannot drain a full burst bucket inside one second`,
      sustained < burst, `${sustained} vs burst ${burst}`)
    check(`budget: ${type} flush interval is a positive integer`,
      Number.isInteger(flushMs) && flushMs > 0, String(flushMs))
  }
}

// ===========================================================================
// 5. Reconnect: backoff, jitter bounds, and which close codes are final.
// ===========================================================================
{
  for (let attempt = 1; attempt <= 8; attempt++) {
    const atZero = reconnectDelay(attempt, () => 0)
    const atOne = reconnectDelay(attempt, () => 1)
    const index = Math.min(Math.max(attempt, 1), 6) - 1
    const base = [500, 1000, 2000, 4000, 8000, 10000][index]
    check(`backoff: attempt ${attempt} stays within +/-25% of ${base}ms`,
      atZero === Math.round(base * 0.75) && atOne === Math.round(base * 1.25) && reconnectDelay(attempt, () => 0.5) === base,
      `lo=${atZero} mid=${reconnectDelay(attempt, () => 0.5)} hi=${atOne}`)
  }
  check('backoff: strictly increasing through the first six attempts',
    [1, 2, 3, 4, 5, 6].map((a) => reconnectDelay(a, () => 0.5)).every((v, i, arr) => i === 0 || v > arr[i - 1]))

  const fatalCases = [
    [4003, 'kicked'],
    [4009, 'replaced'],
    [1001, 'expired'],
    [1009, 'too_big'],
    [1008, 'policy'],
  ]
  for (const [code, expected] of fatalCases) {
    check(`close ${code} is fatal and maps to '${expected}'`,
      isFatalClose(code) && fatalCloseError(code) === expected && closeDisposition(code, false) === 'fatal',
      fatalCloseError(code))
    const out = nextAfterClose({ opened: true, code, attempt: 1 })
    check(`close ${code} never retries`, out.status === 'error' && out.error === expected,
      JSON.stringify(out))
  }
  {
    const out = nextAfterClose({ opened: true, code: 1006, attempt: 1 })
    const lo = Math.round(500 * 0.75)
    const hi = Math.round(500 * 1.25)
    check('close: 1006 after a successful open is retried with backoff',
      out.status === 'reconnecting' && out.attempt === 2 && out.delay >= lo && out.delay <= hi,
      JSON.stringify(out))
  }
  check('close: a socket that never opened is NOT hammered',
    (() => {
      const out = nextAfterClose({ opened: false, code: 1006, attempt: 1 })
      return out.status === 'error' && out.error === 'join_failed'
    })(), JSON.stringify(nextAfterClose({ opened: false, code: 1006, attempt: 1 })))
  check(`close: gives up after ${MAX_RECONNECT_ATTEMPTS} attempts`,
    nextAfterClose({ opened: true, code: 1006, attempt: MAX_RECONNECT_ATTEMPTS }).error === 'retry_exhausted')
  check('close: our own close is idle, not an error',
    (() => {
      const out = nextAfterClose({ opened: true, deliberate: true, code: 1000, attempt: 3 })
      return out.status === 'idle' && out.error === null
    })())
  check('close: FATAL_CLOSE_CODES is frozen and sorted-free of 1006',
    Object.isFrozen(FATAL_CLOSE_CODES) && !FATAL_CLOSE_CODES.includes(1006))
}

// ===========================================================================
// 6. Stroke ids in an insecure context (http://<lan-ip>:5173).
// ===========================================================================
{
  const withUuid = newRoomStrokeId({ randomUUID: () => '00000000-0000-4000-8000-000000000000' })
  check('stroke id: prefers crypto.randomUUID when present',
    withUuid === '00000000-0000-4000-8000-000000000000', withUuid)

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isV4 = (id) => uuidRe.test(id) && id[14] === '4' && '89ab'.includes(id[19])
  const seeded = (bytes) => {
    let i = 0
    return {
      getRandomValues: (arr) => {
        for (let n = 0; n < arr.length; n++) arr[n] = bytes[i++ % bytes.length]
        return arr
      },
    }
  }
  const viaGetRandomValues = newRoomStrokeId(seeded([0xab]))
  check('stroke id: falls back to getRandomValues (no randomUUID), still a v4 uuid',
    isV4(viaGetRandomValues), viaGetRandomValues)

  const noCrypto = newRoomStrokeId(null)
  check('stroke id: falls back to Math.random when crypto is absent',
    isV4(noCrypto), String(noCrypto))

  const noCryptoAtAll = newRoomStrokeId({})
  check('stroke id: a bare object without crypto still yields a v4 uuid',
    isV4(noCryptoAtAll), String(noCryptoAtAll))

  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(newRoomStrokeId(null))
  check('stroke id: 500 fallback ids are unique', ids.size === 500, `${ids.size}`)

  const key = newRoomKey()
  check('wire key: is a uuid and passes the server key rule',
    uuidRe.test(key) && key.length <= serverConfig.MAX_KEY_LENGTH, key)
}

// ===========================================================================
// 7. Inbound frames are hostile: parseRoomMessage returns null, never throws.
// ===========================================================================
{
  const good = { v: 1, t: 'cursor', k: 'k1', x: 10, y: 10 }
  const json = (o) => JSON.stringify(o)

  const inboundCases = [
    ['empty string', ''],
    ['not json', '{nope'],
    ['json but not an object', '"hi"'],
    ['missing version', JSON.stringify({ t: 'cursor', k: 'k1', x: 1, y: 1 })],
    ['wrong version', JSON.stringify({ ...good, v: 2 })],
    ['missing type', JSON.stringify({ v: 1, k: 'k1', x: 1, y: 1 })],
    ['unknown type', JSON.stringify({ ...good, t: 'stroke_remove' })],
    ['cursor beyond the paper', json({ ...good, x: PAPER_SIZE + 1 })],
    ['cursor negative', json({ ...good, y: -1 })],
    ['cursor NaN-as-string', json({ ...good, x: '10' })],
    ['stroke_start with an off-palette colour', json({ v: 1, t: 'stroke_start', k: 'k', id: UUID, userId: UUID2, userName: 'A', color: '#123456', width: 4, pts: [1, 1] })],
    ['stroke_start with a non-palette width', json({ v: 1, t: 'stroke_start', k: 'k', id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 9999, pts: [1, 1] })],
    ['stroke_start with odd-length points', json({ v: 1, t: 'stroke_start', k: 'k', id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 4, pts: [1, 1, 1] })],
    ['stroke_points with seq 0', json({ v: 1, t: 'stroke_points', k: 'k', id: UUID, seq: 0, pts: [1, 1] })],
    ['stroke_points with more than MAX_LIVE_BATCH_NUMBERS', json({ v: 1, t: 'stroke_points', k: 'k', id: UUID, seq: 1, pts: new Array(serverConfig.MAX_LIVE_BATCH_NUMBERS + 2).fill(1) })],
    ['stroke_end with an empty point list', json({ v: 1, t: 'stroke_end', k: 'k', stroke: { id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 4, points: [] } })],
    ['kick with a non-uuid target', json({ v: 1, t: 'kick', userId: 'admin' })],
    ['welcome with a seat past MAX_PLAYERS', json({ v: 1, t: 'welcome', seat: 999, host: false, players: [] })],
    ['cursor with a non-string userId', json({ ...good, userId: 42 })],
    ['snapshot with a fractional round', json({ v: 1, t: 'snapshot', round: 1.5, partial: false, strokes: [] })],
    ['snapshot with a negative round', json({ v: 1, t: 'snapshot', round: -1, partial: false, strokes: [] })],
    ['snapshot with a non-boolean partial', json({ v: 1, t: 'snapshot', round: 1, partial: 'yes', strokes: [] })],
    ['snapshot with strokes that are not an array', json({ v: 1, t: 'snapshot', round: 1, partial: false, strokes: {} })],
    ['snapshot with more than MAX_ROUND_STROKES strokes', json({
      v: 1, t: 'snapshot', round: 1, partial: false,
      strokes: new Array(serverConfig.MAX_ROUND_STROKES + 1).fill({ id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 4, points: [1, 1, 2, 2] }),
    })],
    ['state with an unknown phase', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'dance', remainingMs: 1, drawer: null, wordLen: null, hint: null, scores: {}, correct: [] })],
    ['state with negative remaining', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'pick', remainingMs: -1, drawer: null, wordLen: null, hint: null, scores: {}, correct: [] })],
    ['state with a zero wordLen', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'pick', remainingMs: 1, drawer: null, wordLen: 0, hint: null, scores: {}, correct: [] })],
    ['state with a digit in the hint', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'drawing', remainingMs: 1, drawer: UUID, wordLen: 4, hint: 'p1zz_', scores: {}, correct: [] })],
    ['state with an array for scores', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'scores', remainingMs: 1, drawer: null, wordLen: null, hint: null, scores: [], correct: [] })],
    ['state with a non-numeric score', json({ v: 1, t: 'state', round: 1, rounds: 6, phase: 'scores', remainingMs: 1, drawer: null, wordLen: null, hint: null, scores: { [UUID2]: '10' }, correct: [] })],
    ['word_pick with the wrong option count', json({ v: 1, t: 'word_pick', round: 1, options: ['apple', 'bird'] })],
    ['word_pick with duplicates', json({ v: 1, t: 'word_pick', round: 1, options: ['apple', 'apple', 'bird'] })],
    ['word_pick with an uppercase word', json({ v: 1, t: 'word_pick', round: 1, options: ['Apple', 'bird', 'boat'] })],
    ['your_word past MAX_WORD_LENGTH', json({ v: 1, t: 'your_word', round: 1, word: 'a'.repeat(MAX_WORD_LENGTH + 1) })],
    ['reveal with a bad word', json({ v: 1, t: 'reveal', round: 1, word: 'two words!', correct: [], skipped: false })],
    ['reveal without skipped', json({ v: 1, t: 'reveal', round: 1, word: 'pizza', correct: [] })],
    ['error with an unknown reason', json({ v: 1, t: 'error', reason: 'explode' })],
  ]
  for (const [label, text] of inboundCases) {
    let out
    try {
      out = parseRoomMessage(text)
    } catch (e) {
      out = `threw ${e}`
    }
    check(`inbound drops: ${label}`, out === null, JSON.stringify(out))
  }

  const valid = parseRoomMessage(json(good))
  check('inbound: a well-formed frame parses to {type, data}',
    !!valid && valid.type === 'cursor' && valid.data.x === 10, JSON.stringify(valid))

  // A player whose entry is malformed must be dropped without killing welcome.
  // (userId is only length-checked here — identity is never trusted from the
  // wire, the DO overwrites it — so the hostile id is deliberately kept.)
  const withBadPlayer = parseRoomMessage(json({
    v: 1, t: 'welcome', seat: 0, host: true,
    players: [
      { userId: UUID2, seat: 1, name: 'Fine', country: 'NZ', host: false },
      { userId: UUID2, seat: 9999, name: 'Bad seat', country: 'NZ', host: false },
      { userId: '', seat: 2, name: 'Empty id', country: 'NZ', host: false },
      { userId: 'u3', seat: 'three', name: 'String seat', country: 'NZ', host: false },
    ],
  }))
  check('inbound: players with a bad seat or id are dropped, valid ones kept',
    !!withBadPlayer && withBadPlayer.data.players.length === 1 && withBadPlayer.data.players[0].name === 'Fine',
    JSON.stringify(withBadPlayer))

  const named = parseRoomMessage(json({
    v: 1, t: 'welcome', seat: 0, host: false,
    players: [{ userId: UUID2, seat: 1, name: '   ', country: 'nope', host: false }],
  }))
  check('inbound: blank names become Guest and bad countries become null',
    !!named && named.data.players[0].name === 'Guest' && named.data.players[0].country === null,
    JSON.stringify(named?.data?.players))

  // A snapshot drops the strokes that fail the validator and keeps the rest —
  // the same rule as players in welcome, so one bad entry never blanks paper.
  const mixed = parseRoomMessage(json({
    v: 1, t: 'snapshot', round: 2, partial: true,
    strokes: [
      { id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 4, points: [1, 1, 2, 2] },
      { id: 'not-a-uuid', userId: UUID2, userName: 'A', color: '#e5484d', width: 4, points: [1, 1, 2, 2] },
      { id: UUID2, userId: UUID2, userName: 'A', color: '#123456', width: 4, points: [1, 1, 2, 2] },
      { id: UUID, userId: UUID2, userName: 'A', color: '#e5484d', width: 4, points: [1, 1, 1] },
    ],
  }))
  check('inbound: snapshot drops invalid strokes and keeps valid ones',
    mixed?.data?.strokes?.length === 1 && mixed.data.strokes[0].id === UUID &&
    mixed.data.round === 2 && mixed.data.partial === true,
    JSON.stringify(mixed?.data))

  const canonical = parseRoomMessage(json({
    v: 1, t: 'snapshot', round: 0, partial: false,
    strokes: [{ id: UUID, userId: UUID2, userName: 'A', color: '#E5484D', width: 4, points: [1, 1, 2, 2] }],
  }))
  check('inbound: snapshot strokes canonicalise like stroke_end (colour + brush)',
    canonical?.data?.strokes?.[0]?.color === '#e5484d' && canonical.data.strokes[0].b === 0,
    JSON.stringify(canonical?.data?.strokes?.[0]))

  // A server predating v2 Phase 3 sends cursors without a userId.
  const legacyCursor = parseRoomMessage(json({ v: 1, t: 'cursor', k: 'k1', x: 5, y: 6 }))
  check('inbound: a cursor without userId still parses (older server)',
    legacyCursor?.data?.x === 5 && legacyCursor?.data?.y === 6, JSON.stringify(legacyCursor))
}

// ===========================================================================
// 8. HTTP: probeRoom and createRoom, including the single 401 refresh.
// ===========================================================================
const makeAuth = (tokens, refreshTokens = []) => {
  const reads = [...tokens]
  const refreshes = [...refreshTokens]
  return {
    getToken: async () => (reads.length ? reads.shift() : null),
    refresh: async () => (refreshes.length ? refreshes.shift() : null),
  }
}

const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

const recorder = (queue) => {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = queue.length ? queue.shift() : null
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('fetch queue exhausted')
    return next
  }
  fn.calls = calls
  return fn
}

{
  const fetchImpl = recorder([response(200, { code: 'abcde' })])
  const out = await createRoom({ roomsUrl: 'https://rooms.test', auth: makeAuth(['t1']), turn: 'tok', fetchImpl })
  check('createRoom: returns an upper-cased code', out.ok === true && out.code === 'ABCDE', JSON.stringify(out))
  check('createRoom: POSTs to /rooms with a bearer token',
    fetchImpl.calls.length === 1 &&
    fetchImpl.calls[0].url === 'https://rooms.test/rooms' &&
    fetchImpl.calls[0].init.method === 'POST' &&
    fetchImpl.calls[0].init.headers.Authorization === 'Bearer t1',
    JSON.stringify(fetchImpl.calls[0]?.init?.headers))
  check('createRoom: sends the Turnstile token in the body, not a header',
    fetchImpl.calls[0].init.headers['content-type'] === 'application/json' &&
    JSON.parse(fetchImpl.calls[0].init.body).turn === 'tok',
    fetchImpl.calls[0].init.body)
}
{
  const fetchImpl = recorder([response(200, { code: '11111' })])
  const out = await createRoom({ roomsUrl: 'https://rooms.test', auth: makeAuth(['t1']), fetchImpl })
  check('createRoom: an invalid code in the response is an error, not a join',
    out.ok === false && out.error === 'unreachable', JSON.stringify(out))
}
{
  const auth = makeAuth(['t1', 't1'], ['t2'])
  const fetchImpl = recorder([response(401, {}), response(200, { code: 'ABCDE' })])
  const out = await createRoom({ roomsUrl: 'https://rooms.test', auth, fetchImpl })
  check('createRoom: one readable 401 refreshes the session and retries exactly once',
    out.ok === true && out.code === 'ABCDE' && fetchImpl.calls.length === 2,
    `calls=${fetchImpl.calls.length} ${JSON.stringify(out)}`)
  check('createRoom: the retry carries the refreshed token',
    fetchImpl.calls[1].init.headers.Authorization === 'Bearer t2',
    fetchImpl.calls[1].init.headers.Authorization)
}
{
  const auth = { getToken: async () => 't1', refresh: async () => null }
  const fetchImpl = recorder([response(401, {})])
  const out = await createRoom({ roomsUrl: 'https://rooms.test', auth, fetchImpl })
  check('createRoom: a 401 with no refresh becomes auth (never loops)',
    out.ok === false && out.error === 'auth' && fetchImpl.calls.length === 1,
    `calls=${fetchImpl.calls.length} ${JSON.stringify(out)}`)
}
{
  const auth = { getToken: async () => null, refresh: async () => null }
  const fetchImpl = recorder([])
  const out = await createRoom({ roomsUrl: 'https://rooms.test', auth, fetchImpl })
  check('createRoom: no session short-circuits before any request',
    out.ok === false && out.error === 'auth' && fetchImpl.calls.length === 0, JSON.stringify(out))
}

// ---- probeRoom --------------------------------------------------------------
{
  const fetchImpl = recorder([response(200, { players: 3, full: false })])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
  check('probe: reports the player count', out.ok === true && out.players === 3 && out.full === false,
    JSON.stringify(out))
  check('probe: returns ONLY ok/players/full — no identity fields leak',
    JSON.stringify(Object.keys(out).sort()) === '["full","ok","players"]', JSON.stringify(Object.keys(out).sort()))
}
{
  // The server may grow the status body; the client must not start surfacing
  // whatever else is in there.
  const fetchImpl = recorder([response(200, {
    players: 2, full: false,
    names: ['a', 'b'], hostUserId: UUID, seats: { [UUID]: 0 }, ipHash: 'abc',
  })])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
  const keys = Object.keys(out).sort()
  check('probe: extra fields in the status body are ignored, not forwarded',
    JSON.stringify(keys) === '["full","ok","players"]', JSON.stringify(keys))
}
{
  const fetchImpl = recorder([response(200, { players: 12, full: true })])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
  check('probe: surfaces full=true so the transport can stop before the socket',
    out.ok === true && out.full === true, JSON.stringify(out))
}
{
  const cases = [
    [400, {}, 'bad_code'],
    [401, {}, 'auth'],
    [403, { error: 'kicked' }, 'kicked'],
    [403, { error: 'origin' }, 'origin'],
    [403, { error: 'captcha' }, 'auth'],
    [403, {}, 'banned'],
    [404, {}, 'not_found'],
    [429, { error: 'too_many_connections' }, 'too_many'],
    [429, {}, 'rate_limited'],
    [503, {}, 'busy'],
    [418, {}, 'unreachable'],
  ]
  for (const [status, body, expected] of cases) {
    const fetchImpl = recorder([response(status, body)])
    const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
    check(`probe: HTTP ${status} ${JSON.stringify(body)} -> ${expected}`,
      out.ok === false && out.error === expected, JSON.stringify(out))
  }
}
{
  const fetchImpl = recorder([new Error('network down')])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
  check('probe: a network failure is unreachable, not a throw',
    out.ok === false && out.error === 'unreachable', JSON.stringify(out))
}
{
  const fetchImpl = recorder([])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'nope', auth: makeAuth(['t1']), fetchImpl })
  check('probe: a malformed code never reaches the network',
    out.ok === false && out.error === 'bad_code' && fetchImpl.calls.length === 0, JSON.stringify(out))
}
{
  const fetchImpl = recorder([])
  const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'abcde', auth: makeAuth(['t1']), fetchImpl })
  check('probe: a lowercase code is rejected before any request (codes are exact)',
    out.ok === false && out.error === 'bad_code' && fetchImpl.calls.length === 0, JSON.stringify(out))
}

// ===========================================================================
// 9. Clipboard, secure context or not.
// ===========================================================================
{
  const writes = []
  const clipboard = { writeText: async (t) => { writes.push(t) } }
  const out = await copyText('ABCDE', { clipboard })
  check('clipboard: uses navigator.clipboard in a secure context',
    out === 'clipboard' && writes.length === 1 && writes[0] === 'ABCDE', out)
}
{
  const doc = { createRange: () => ({ selectNodeContents() {} }) }
  const selection = { ranges: [], removeAllRanges() { this.ranges = [] }, addRange(r) { this.ranges.push(r) } }
  doc.getSelection = () => selection
  const clipboard = { writeText: async () => { throw new Error('denied') } }
  const target = { id: 'code' }
  const out = await copyText('ABCDE', { clipboard, target, document: doc })
  check('clipboard: a denied write falls back to selecting the code in place',
    out === 'selected' && selection.ranges.length === 1, out)
}
{
  const clipboard = { writeText: async () => { throw new Error('denied') } }
  const out = await copyText('ABCDE', { clipboard })
  check('clipboard: denied with no target is "failed", never a throw',
    out === 'failed', String(out))
}
{
  const doc = { createRange: () => { throw new Error('nope') } }
  const clipboard = { writeText: async () => { throw new Error('denied') } }
  const out = await copyText('ABCDE', { clipboard, target: {}, document: doc })
  check('clipboard: a throwing selection path is "failed", never a throw',
    out === 'failed', String(out))
}
{
  const doc = { createRange: () => ({ selectNodeContents() {} }), getSelection: () => null }
  const clipboard = { writeText: async () => { throw new Error('denied') } }
  const out = await copyText('ABCDE', { clipboard, target: {}, document: doc })
  check('clipboard: no getSelection is "failed"', out === 'failed', String(out))
}
{
  const out = await copyText('ABCDE', { clipboard: undefined, target: null, document: null })
  check('clipboard: a browser with no clipboard and no document is "failed"',
    out === 'failed', String(out))
}

// ===========================================================================
// 10. Every failure the transport can produce has a human sentence, and
//     exactly the retryable ones offer a retry.
// ===========================================================================
{
  const producible = new Set(TRANSPORT_ONLY_ERRORS)

  for (const status of [400, 401, 404, 503, 418]) {
    const fetchImpl = recorder([response(status, {})])
    const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
    if (out.error) producible.add(out.error)
  }
  for (const body of [{ error: 'kicked' }, { error: 'origin' }, { error: 'captcha' }, {}]) {
    const fetchImpl = recorder([response(403, body)])
    const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
    if (out.error) producible.add(out.error)
  }
  for (const body of [{ error: 'too_many_connections' }, {}]) {
    const fetchImpl = recorder([response(429, body)])
    const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl })
    if (out.error) producible.add(out.error)
  }
  for (const code of [1000, 1001, 1006, 1008, 1009, 4003, 4009, 9999]) {
    for (const opened of [true, false]) {
      for (const attempt of [1, MAX_RECONNECT_ATTEMPTS]) {
        const out = nextAfterClose({ opened, code, attempt })
        if (out.error) producible.add(out.error)
      }
    }
  }
  {
    const fetchImpl = recorder([])
    const out = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'nope', auth: makeAuth(['t1']), fetchImpl })
    if (out.error) producible.add(out.error)
    const noToken = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth([]), fetchImpl })
    if (noToken.error) producible.add(noToken.error)
    const net = await probeRoom({ roomsUrl: 'https://rooms.test', code: 'ABCDE', auth: makeAuth(['t1']), fetchImpl: recorder([new Error('x')]) })
    if (net.error) producible.add(net.error)
  }

  const missingCopy = [...producible].filter((e) => !(e in ROOM_ERROR_COPY))
  const deadCopy = Object.keys(ROOM_ERROR_COPY).filter((e) => !producible.has(e))
  check('errors: every producible error has a human sentence',
    missingCopy.length === 0, `missing=${missingCopy}`)
  check('errors: no human sentence is unreachable (dead copy)',
    deadCopy.length === 0, `dead=${deadCopy}`)
  check('errors: no empty sentences', Object.values(ROOM_ERROR_COPY).every((v) => typeof v === 'string' && v.length > 0))
  check('errors: RETRYABLE_ERRORS is a subset of the copy',
    RETRYABLE_ERRORS.every((e) => e in ROOM_ERROR_COPY),
    JSON.stringify(RETRYABLE_ERRORS.filter((e) => !(e in ROOM_ERROR_COPY))))
  check('errors: a final screen (kicked) is never offered a retry',
    !RETRYABLE_ERRORS.includes('kicked') && !RETRYABLE_ERRORS.includes('expired') &&
    !RETRYABLE_ERRORS.includes('replaced') && !RETRYABLE_ERRORS.includes('full'))
}

// Comments are prose: guards below read the code, not the commentary.
function sourceCode(rel) {
  return readSource(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

// ===========================================================================
// 11. Source guards: the rules that are invisible to unit tests but easy to
//     break while editing.
// ===========================================================================
{
  const paper = sourceCode('src/rooms/RoomPaper.jsx')
  check('RoomPaper: stroke ids come from the guarded helper', paper.includes('newRoomStrokeId('))
  check('RoomPaper: never calls crypto.randomUUID directly', !paper.includes('crypto.randomUUID'))
  check('RoomPaper: rooms have no zoom, so there is no wheel handler',
    !paper.includes("'wheel'") && !paper.includes('"wheel"'))
  check('RoomPaper: rooms have no pinch gesture',
    !paper.includes('gesturestart') && !paper.includes('gesturechange'))
  check('RoomPaper: no undo or report controls',
    !paper.includes('onUndo') && !paper.includes('reportMode'))
  check('RoomPaper: does not import the plaza Toolbar',
    !paper.includes("from '../components/Toolbar.jsx'"))

  const screen = sourceCode('src/rooms/RoomScreen.jsx')
  check('RoomScreen: reads its copy from roomsErrors.js', screen.includes("from './roomsErrors.js'"))

  const transport = sourceCode('src/rooms/useRoomTransport.js')
  check('transport: flushes points on the shared constant', transport.includes('ROOM_POINT_FLUSH_MS'))
  check('transport: flushes cursors on the shared constant', transport.includes('ROOM_CURSOR_FLUSH_MS'))
  check('transport: reconnects through the shared backoff', transport.includes('nextAfterClose'))
  check('transport: probes before opening a socket', transport.includes('probeRoom('))
  check('transport: takes a fresh session per attempt', transport.includes('createRoomsAuth()'))
  check('transport: never puts the token in the URL',
    !/ws\?.*token/i.test(transport) && !transport.includes('${token}'))
  check('transport: never logs the token', !transport.includes('console.log'))
  check('transport: applies the snapshot frame', transport.includes("case 'snapshot'"))
  check('transport: applies snapshots by diff, never a wholesale replace',
    !transport.includes('replaceAll'))

  // The round (and later the secret word) lives server-side only: nothing the
  // room client learns may be written to browser storage.
  const storageOffenders = readdirSync(path.join(root, 'src', 'rooms'))
    .filter((f) => /\.(js|jsx)$/.test(f))
    .filter((f) => readSource(`src/rooms/${f}`).includes('localStorage'))
  check('src/rooms: never touches localStorage', storageOffenders.length === 0,
    JSON.stringify(storageOffenders))

  const home = sourceCode('src/rooms/RoomsHome.jsx')
  check('rooms home: validates the code before navigating', home.includes('ROOM_CODE_RE.test'))

  const app = sourceCode('src/rooms/RoomsApp.jsx')
  check('rooms app: only routes /rooms and /r/<code>', app.includes('/r/') && app.includes('ROOM_CODE_RE'))

  const main = sourceCode('src/main.jsx')
  check('main: rooms are lazily loaded, like admin', main.includes("lazy(() => import('./rooms/RoomsApp.jsx'))"))
  check('main: /rooms and /r/ both reach RoomsApp',
    main.includes("pathname === '/rooms'") && main.includes("pathname.startsWith('/r/')"))

  const vercel = JSON.parse(readSource('vercel.json'))
  const sources = vercel.rewrites.map((r) => r.source)
  check('vercel.json: /rooms and /r/:path* rewrite to index.html',
    sources.includes('/rooms') && sources.includes('/r/:path*'), JSON.stringify(sources))
  check('vercel.json: the plaza root is untouched', !sources.includes('/'))

  const env = readSource('.env.example')
  check('.env.example: documents VITE_ROOMS_URL', env.includes('VITE_ROOMS_URL='))
  check('.env.example: no real rooms URL is committed',
    !/VITE_ROOMS_URL=\s*https?:\/\//.test(env))
}

// ===========================================================================
// 12. src/ must never import rooms/ (a standalone Cloudflare project). The
//     wire is mirrored precisely so the app builds without the worker in its
//     dependency graph.
// ===========================================================================
{
  const offenders = []
  const IMPORT_RE = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(js|jsx|mjs|ts|tsx)$/.test(entry.name)) continue
      const src = readFileSync(full, 'utf8')
      for (const m of src.matchAll(IMPORT_RE)) {
        if (/(^|\/)rooms\/src\//.test(m[1])) offenders.push(`${path.relative(root, full)} -> ${m[1]}`)
      }
    }
  }
  walk(path.join(root, 'src'))
  check('src/ does not import rooms/src (the wire is mirrored, not shared)',
    offenders.length === 0, JSON.stringify(offenders))
}

// ===========================================================================
// 13. The plaza's entry point into rooms. It is a link, not a widget: the
//     plaza must be byte-for-byte what it was wherever VITE_ROOMS_URL is
//     unset, so the whole decision is a pure function that can be proven.
// ===========================================================================
{
  check('entry: absent when VITE_ROOMS_URL is unset', roomsEntryHref({}) === null)
  check('entry: absent when VITE_ROOMS_URL is empty', roomsEntryHref({ VITE_ROOMS_URL: '' }) === null)
  check('entry: absent when there is no env object at all', roomsEntryHref(undefined) === null)
  check('entry: present when set, and links to /rooms',
    roomsEntryHref({ VITE_ROOMS_URL: 'https://example.invalid' }) === '/rooms')

  const pill = sourceCode('src/components/StatusPill.jsx')
  check('StatusPill: renders the link through the gated helper', pill.includes('roomsEntryHref(import.meta.env)'))
  check('StatusPill: the anchor takes its href from the helper', /<a href=\{roomsHref\}/.test(pill))
  check('StatusPill: the link text is exactly "Play with friends"', pill.includes('Play with friends'))
  check('StatusPill: the link lives in the existing footer row',
    pill.indexOf('className="status-footer"') < pill.indexOf('Play with friends'))
  check('StatusPill: a plain anchor — no click handler, no new dependency',
    !pill.includes('onClick') && !pill.includes('<button'))
  check('StatusPill: no worker URL is ever carried by the plaza',
    !pill.includes('workers.dev') && !pill.includes('VITE_ROOMS_URL'))

  // No plaza file may read the variable itself: the gate lives in
  // src/lib/roomsEntry.js, so the plaza cannot grow a second way to point at
  // a Worker.
  const plazaDirs = ['src/components', 'src/engine', 'src/hooks']
  const misreads = []
  for (const dir of plazaDirs) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const rel = `${dir}/${entry.name}`
      if (readFileSync(path.join(root, rel), 'utf8').includes('VITE_ROOMS_URL')) misreads.push(rel)
    }
  }
  check('no plaza file reads VITE_ROOMS_URL directly (the gate is roomsEntryHref)',
    misreads.length === 0, JSON.stringify(misreads))
}

// ===========================================================================
// 14. The plaza guard: apart from the one approved entry-point change, the
//     plaza must stay byte-identical to v2-wire-prep. Skips loudly if the
//     reference branch is not in this clone rather than failing a CI run.
// ===========================================================================
{
  const REF = 'v2-wire-prep'
  const PLAZA_PATHS = [
    'src/components',
    'src/engine',
    'src/hooks',
    'src/lib/strokeCodec.js',
    'src/lib/wire.js',
    'src/lib/stroke.js',
  ]
  const ALLOWED = new Set(['src/components/StatusPill.jsx'])

  let git = null
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', REF], { cwd: root, stdio: 'pipe' })
    git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    console.log(`  skip plaza guard (no git or no ${REF} ref in this clone)`)
  }

  if (git) {
    const diffOut = git(['diff', '--name-only', REF, '--', ...PLAZA_PATHS])
    const changed = diffOut ? diffOut.split('\n') : []
    const unexpected = changed.filter((p) => !ALLOWED.has(p))
    check('plaza guard: the only file differing from v2-wire-prep is StatusPill.jsx',
      unexpected.length === 0, JSON.stringify({ changed, unexpected }))

    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...PLAZA_PATHS])
    const added = untracked ? untracked.split('\n') : []
    check('plaza guard: no new file under the plaza paths', added.length === 0, JSON.stringify(added))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
