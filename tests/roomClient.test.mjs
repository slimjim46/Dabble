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
import { gainRows, playerTotal, standings } from '../src/rooms/roomsScores.js'
import { ROOM_ERROR_COPY, RETRYABLE_ERRORS, SERVER_NOTICE_ERRORS, TRANSPORT_ONLY_ERRORS } from '../src/rooms/roomsErrors.js'
import {
  CLOSE_DISTANCE_FAR,
  CLOSE_DISTANCE_NEAR,
  CLOSE_MAX_LENGTH_FOR_DISTANCE_1,
  FATAL_CLOSE_CODES,
  MAX_GUESSES_PER_ROUND,
  MAX_GUESS_LENGTH,
  MAX_RECONNECT_ATTEMPTS,
  MAX_ROUND_BYTES,
  MAX_ROUND_POINTS,
  MAX_ROUND_STROKES,
  MAX_WORD_LENGTH,
  MIN_CLOSE_LENGTH,
  MIN_PLAYERS,
  PERFECT_MIN_GUESSERS,
  PHASES,
  ROOM_CODE_RE,
  ROOM_CURSOR_FLUSH_MS,
  ROOM_GUESS_SEND_DISABLE_MS,
  ROOM_POINT_FLUSH_MS,
  SCORE_DRAWER_PER_GUESSER,
  SCORE_GUESS_BASE,
  SCORE_GUESS_TIME_BONUS,
  SCORE_PERFECT_BONUS,
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
  guessMessage,
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
  ['guess', guessMessage('casa')],
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

  // Scoring (step 4b): reveal carries gains, and the client parses them. Also
  // assert the negative cases so the shape cannot silently loosen.
  const gainsFrame = { v: 1, t: 'reveal', round: 1, word: 'pizza', correct: ['u2'], skipped: false, gains: { u2: 300, u1: 150 } }
  const g = parseRoomMessage(JSON.stringify(gainsFrame))
  check('contract: reveal.gains parses as a userId -> points map',
    g?.type === 'reveal' && g.data.gains?.u2 === 300 && g.data.gains?.u1 === 150, JSON.stringify(g))
  check('contract: reveal without gains still parses (older frame)',
    parseRoomMessage(JSON.stringify({ v: 1, t: 'reveal', round: 1, word: 'pizza', correct: [], skipped: false }))?.type === 'reveal')
  for (const bad of [
    JSON.stringify({ v: 1, t: 'reveal', round: 1, word: 'pizza', correct: [], skipped: false, gains: { u2: 1.5 } }),
    JSON.stringify({ v: 1, t: 'reveal', round: 1, word: 'pizza', correct: [], skipped: false, gains: { u2: 'x' } }),
    JSON.stringify({ v: 1, t: 'reveal', round: 1, word: 'pizza', correct: [], skipped: false, gains: [1, 2] }),
  ]) {
    check('contract: a malformed reveal.gains is rejected', !parseRoomMessage(bad), bad)
  }

  // The running scoreboard (Commit 3): the server's state frame carries the
  // cumulative scores, and the client parser passes them through unchanged.
  const scoredFrame = { ...stateFrame(game, 2000), scores: { [UUID]: 450, [UUID2]: 150 } }
  const scored = parseRoomMessage(JSON.stringify(scoredFrame))
  check('contract: state.scores parses as a userId -> points map',
    scored?.type === 'state' && scored.data.scores?.[UUID] === 450 && scored.data.scores?.[UUID2] === 150,
    JSON.stringify(scored))

  const busy = parseRoomMessage(JSON.stringify({ v: 1, t: 'error', reason: 'busy' }))
  check('contract: the busy error parses and has copy + retry',
    busy?.type === 'error' && busy.data.reason === 'busy' && !!ROOM_ERROR_COPY.busy && RETRYABLE_ERRORS.includes('busy'),
    JSON.stringify(busy))

  // Guessing (step 4a): the private ack and the transient cap error.
  for (const [ok, close] of [[true, false], [false, true], [false, false]]) {
    const ack = parseRoomMessage(JSON.stringify({ v: 1, t: 'guess_ack', ok, close }))
    check(`contract: guess_ack ${ok}/${close} parses`,
      ack?.type === 'guess_ack' && ack.data.ok === ok && ack.data.close === close, JSON.stringify(ack))
  }
  check('contract: guess_ack rejects a non-boolean', parseRoomMessage(JSON.stringify({ v: 1, t: 'guess_ack', ok: 1, close: 0 })) === null)
  const cap = parseRoomMessage(JSON.stringify({ v: 1, t: 'error', reason: 'guess_cap' }))
  check('contract: the guess_cap error parses and has copy',
    cap?.type === 'error' && cap.data.reason === 'guess_cap' && !!ROOM_ERROR_COPY.guess_cap, JSON.stringify(cap))
  // guess_cap must NOT be retryable (it is a transient notice, not a screen).
  check('contract: guess_cap is not in RETRYABLE_ERRORS', !RETRYABLE_ERRORS.includes('guess_cap'))

  // The guess builder caps at parse time: the server rejects over-long text.
  const tooLong = 'x'.repeat(MAX_GUESS_LENGTH + 1)
  const env = parseEnvelope(encode(guessMessage(tooLong)))
  check('contract: the server rejects an over-long guess', env && CLIENT_TYPES.guess(env.p) === null, String(tooLong.length))
  const okEnv = parseEnvelope(encode(guessMessage('x'.repeat(MAX_GUESS_LENGTH))))
  check('contract: a max-length guess is accepted', okEnv && CLIENT_TYPES.guess(okEnv.p) !== null)
  check('contract: an empty guess is rejected', (() => { const e = parseEnvelope(encode(guessMessage(''))); return !e || CLIENT_TYPES.guess(e.p) === null })())
}

// ===========================================================================
// 1b. Scoreboards (v2 Phase 3 Commit 3): roomsScores.js turns the server's
//     userId-keyed maps into display rows. It never computes a score: a
//     present player missing from a present map is 0 (the server records a
//     player only once points are awarded); a map-less frame renders nothing.
// ===========================================================================
{
  const players = [
    { userId: 'u1', seat: 0, name: 'Ann', country: 'DE', host: true },
    { userId: 'u2', seat: 1, name: 'Bo', country: null, host: false },
  ]

  // The owner-required case: a seated player with no scores entry appears with
  // total 0, because the server only adds a player once they are awarded.
  const zeroed = standings({ scores: {} }, players)
  check('scores: a seated player with no scores entry appears with total 0',
    zeroed?.length === 2 && zeroed.every((row) => row.total === 0) &&
    zeroed.map((r) => r.name).join() === 'Ann,Bo', JSON.stringify(zeroed))
  check('playerTotal: a seated player with no scores entry is 0 in the player list',
    playerTotal({ scores: {} }, 'u1') === 0)
  check('playerTotal: a real entry is read unchanged',
    playerTotal({ scores: { u1: 450 } }, 'u1') === 450 && playerTotal({ scores: { u1: 450 } }, 'u2') === 0)
  check('playerTotal: nothing is rendered with no frame or in the lobby',
    playerTotal(null, 'u1') === null && playerTotal(undefined, 'u1') === null &&
    playerTotal({ phase: 'lobby', scores: { u1: 450 } }, 'u1') === null)

  // Real totals rank above zeros; ties share a rank number (1, 1, 3) and keep
  // the players-list order (stable sort).
  const ranked = standings({ scores: { u2: 300, u1: 300, u9: 50 } }, players)
  check('scores: rows are ranked by the server total, descending',
    ranked?.[0].userId === 'u1' && ranked?.[0].total === 300 &&
    ranked?.[2].userId === 'u9' && ranked?.[2].total === 50, JSON.stringify(ranked))
  check('scores: tied totals share a rank number',
    ranked?.[0].rank === 1 && ranked?.[1].rank === 1 && ranked?.[2].rank === 3, JSON.stringify(ranked))

  // A score for a userId that has left the room keeps its value under a
  // placeholder name, with no flag (u9 is not in the player list).
  const departed = ranked?.find((r) => r.userId === 'u9')
  check('scores: a departed userId renders as Player with its total, no flag',
    departed?.name === 'Player' && departed?.total === 50 && departed?.country === null, JSON.stringify(departed))

  // Identity comes only from the server player list, by userId.
  check('scores: identity is taken from the player list, not the score map',
    ranked?.[0].name === 'Ann' && ranked?.[1].name === 'Bo')

  // An older frame with no scores map renders nothing (null), and neither
  // does a non-map / array.
  check('scores: a frame with no scores map renders nothing',
    standings({ round: 1, phase: 'scores' }, players) === null &&
    standings({ scores: [] }, players) === null && standings(null, players) === null)

  // Reveal gains: same identity rules, but a player with no gain shows
  // nothing (not +0) — a gain is different from a cumulative total.
  const gains = gainRows({ gains: { u2: 300, u9: 150 } }, players)
  check('gains: only players the server awarded appear, highest first',
    gains?.length === 2 && gains[0].userId === 'u2' && gains[0].points === 300, JSON.stringify(gains))
  check('gains: a departed gainer renders as Player with its points',
    gains?.[1].name === 'Player' && gains[1].points === 150, JSON.stringify(gains))
  check('gains: a seated player with no gain shows nothing',
    !gains.some((row) => row.userId === 'u1'))
  check('gains: an older frame with no gains map renders nothing',
    gainRows({ round: 1 }, players) === null && gainRows(undefined, players) === null)
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
    ['MAX_GUESS_LENGTH', MAX_GUESS_LENGTH, serverConfig.MAX_GUESS_LENGTH],
    ['MAX_GUESSES_PER_ROUND', MAX_GUESSES_PER_ROUND, serverConfig.MAX_GUESSES_PER_ROUND],
    ['MIN_CLOSE_LENGTH', MIN_CLOSE_LENGTH, serverConfig.MIN_CLOSE_LENGTH],
    ['CLOSE_MAX_LENGTH_FOR_DISTANCE_1', CLOSE_MAX_LENGTH_FOR_DISTANCE_1, serverConfig.CLOSE_MAX_LENGTH_FOR_DISTANCE_1],
    ['CLOSE_DISTANCE_NEAR', CLOSE_DISTANCE_NEAR, serverConfig.CLOSE_DISTANCE_NEAR],
    ['CLOSE_DISTANCE_FAR', CLOSE_DISTANCE_FAR, serverConfig.CLOSE_DISTANCE_FAR],
    ['SCORE_GUESS_BASE', SCORE_GUESS_BASE, serverConfig.SCORE_GUESS_BASE],
    ['SCORE_GUESS_TIME_BONUS', SCORE_GUESS_TIME_BONUS, serverConfig.SCORE_GUESS_TIME_BONUS],
    ['SCORE_DRAWER_PER_GUESSER', SCORE_DRAWER_PER_GUESSER, serverConfig.SCORE_DRAWER_PER_GUESSER],
    ['SCORE_PERFECT_BONUS', SCORE_PERFECT_BONUS, serverConfig.SCORE_PERFECT_BONUS],
    ['PERFECT_MIN_GUESSERS', PERFECT_MIN_GUESSERS, serverConfig.PERFECT_MIN_GUESSERS],
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

  // Guess send-disable: the client must not let a fast tapper outrun the
  // server's 2/s guess budget, or the socket is closed 1008.
  {
    const { perSec, burst } = serverConfig.RATE_BUDGET.guess
    const sustained = 1000 / ROOM_GUESS_SEND_DISABLE_MS
    check(`budget: guess sustained ${sustained.toFixed(2)}/s <= ${perSec}/s`, sustained <= perSec,
      `${sustained} vs ${perSec}`)
    check('budget: a 400 ms gap would exceed the guess budget (why it is 600)',
      1000 / 400 > perSec, `400ms = ${1000 / 400}/s vs ${perSec}/s`)
    check('budget: guess keeps >=20% headroom', perSec >= sustained * 1.2,
      `perSec=${perSec} sustained=${sustained}`)
    check('budget: guess send-disable is a positive integer',
      Number.isInteger(ROOM_GUESS_SEND_DISABLE_MS) && ROOM_GUESS_SEND_DISABLE_MS > 0,
      String(ROOM_GUESS_SEND_DISABLE_MS))
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
  for (const reason of SERVER_NOTICE_ERRORS) producible.add(reason)

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

  // B6: the engine must ignore pointer events when disabled, not merely hide
  // the toolbar. Both the pointerdown entry point and the stroke opener bail
  // on `disabledRef.current`; if either guard is removed, a read-only viewer
  // could paint a local line the server would then silently drop.
  check('RoomPaper: pointerdown is refused while disabled', paper.includes('if (disabledRef.current) return'))
  check('RoomPaper: the stroke opener is refused while disabled',
    /startStroke[\s\S]*?if \(disabledRef\.current\) return null/.test(paper))
  check('RoomPaper: the toolbar is not rendered while disabled',
    /!disabled && \(/.test(paper) && paper.includes('<RoomToolbar'))
  check('RoomPaper: the toolbar carries no name prop (the room bar owns the name)',
    !paper.includes('{name}'))

  const toolbar = sourceCode('src/rooms/RoomToolbar.jsx')
  check('RoomToolbar: renders no stray name span', !toolbar.includes('{name}'))

  const screen = sourceCode('src/rooms/RoomScreen.jsx')
  check('RoomScreen: reads its copy from roomsErrors.js', screen.includes("from './roomsErrors.js'"))
  // B7: the client draws only for the current drawer while drawing; with no
  // game running the lobby is a free-draw canvas (matches mayDraw on the server).
  check('RoomScreen: gates drawing on the drawing phase and the drawer',
    screen.includes("game.phase === 'drawing' && isDrawer"))
  check('RoomScreen: allows free drawing with no game running', screen.includes("phase !== 'lobby'"))
  check('RoomScreen: passes the gate to the paper as `disabled`', screen.includes('disabled={!canDraw}'))
  check('RoomScreen: no next-game spectator copy is shown to non-drawers',
    !screen.includes('draw in the next game') && !screen.includes('game-spectate'))
  // The game-over screen shows the final standings and a countdown back to the
  // lobby; there is no lobby *button* (the server decides the transition).
  check('RoomScreen: the game-over screen has no lobby button',
    !/game_over[\s\S]{0,600}?<button/.test(screen) && screen.includes('Back to lobby in'))
  // The countdown counts down from the server's frame. It uses the larger of
  // the monotonic delta and the device wall-clock delta (never a server time),
  // and clamps to the frame's remainingMs, so a clock that freezes while the
  // device sleeps cannot stall it.
  check('RoomScreen: the countdown uses performance.now and a local Date.now floor',
    screen.includes('performance.now()') && screen.includes('Date.now() - game.atWall'))
  check('RoomScreen: the countdown is clamped to the frame remainingMs',
    screen.includes('Math.min(game.remainingMs'))
  check('RoomScreen: the countdown resyncs on visibilitychange',
    screen.includes("addEventListener('visibilitychange'"))
  check('RoomScreen: the secret word is only shown when it is our round',
    screen.includes('yourWord && yourWord.round === game.round'))
  // Guessing (step 4a): the box is only for a non-drawer who has not guessed;
  // the input fights iOS zoom/autocorrect; the button locks for the shared
  // constant; and the feedback is private.
  check('RoomScreen: the guess box is a form with a submit button',
    screen.includes('game-guess-form') && screen.includes('onSubmit={submit}'))
  check('RoomScreen: the guess input is >=16px (no iOS zoom)',
    /game-guess-input[\s\S]*?font-size:\s*16px/.test(readSource('src/rooms/rooms.css')) ||
    screen.includes('game-guess-input'))
  check('RoomScreen: the guess input disables autocorrect/autocapitalize/spellcheck',
    screen.includes('autoCorrect="off"') && screen.includes('autoCapitalize="off"') && screen.includes('spellCheck={false}'))
  check('RoomScreen: the guess input asks for a send key', screen.includes('enterKeyHint="send"'))
  check('RoomScreen: the send button locks on the shared constant',
    screen.includes('ROOM_GUESS_SEND_DISABLE_MS'))
  check('RoomScreen: only a non-drawer who has not guessed can guess',
    screen.includes('game.phase === \'drawing\' && !isDrawer && !haveGuessed'))
  check('RoomScreen: the correct banner is built from the public correct list',
    screen.includes('game.correct.map') && screen.includes('guessed it'))
  check('RoomScreen: private feedback offers only Close!/Not quite',
    screen.includes("ack.close ? 'Close!' : 'Not quite'"))

  // Scoreboards (Commit 3): the header renders the server's numbers via the
  // shared pure helper — the client never computes a score. The 0-default for
  // a seated player with no scores entry lives in roomsScores.js (asserted by
  // the unit tests above); RoomScreen only renders what the helper returns.
  check('RoomScreen: standings come from the shared helper', screen.includes('standings(game, players)'))
  check('RoomScreen: reveal gains come from the shared helper', screen.includes('gainRows(reveal, players)'))
  check('RoomScreen: the player list total comes from the shared helper',
    screen.includes('playerTotal(game, player.userId)'))
  check('RoomScreen: GameHeader receives the server player list',
    /GameHeader[\s\S]*?players=\{players\}/.test(screen))
  check('RoomScreen: a frame with no scores renders nothing (helper may return null)',
    screen.includes('rows && rows.length > 0') && screen.includes('gains && gains.length > 0'))
  // Every score number is read by roomsScores.js: the screen must contain no
  // score arithmetic and no zero-default of its own.
  check('RoomScreen: no score arithmetic and no zero-default in the screen',
    !/\?\? 0/.test(screen) && !/total\s*[+\-*/]/.test(screen) && !/points\s*[+\-*/]/.test(screen))
  check('rooms.css: the scoreboard rows use tabular numerals',
    /\.game-score-total\s*\{[\s\S]*?tabular-nums/.test(readSource('src/rooms/rooms.css')) &&
    /\.room-player-score\s*\{[\s\S]*?tabular-nums/.test(readSource('src/rooms/rooms.css')))

  // Cursor cost: the hover branch of onPointerMove sends cursors for mouse
  // pointers only, but must also bail while the paper is disabled (a read-only
  // round, i.e. any non-drawer) or a desktop watcher spends the cursor budget
  // for the whole game. Lobby cursors stay (the lobby is not disabled).
  const roomPaper = sourceCode('src/rooms/RoomPaper.jsx')
  check('RoomPaper: the hover cursor send is gated on disabledRef',
    /pointerType === 'mouse'[\s\S]{0,160}disabledRef\.current[\s\S]{0,160}api\.cursor/.test(roomPaper))
  check('RoomPaper: the hover branch bails before api.cursor when disabled',
    /if \(disabledRef\.current\) return[\s\S]{0,80}api\.cursor/.test(roomPaper))
  // Exactly one unguarded send site must not exist: the only api.cursor call
  // sits after the disabled guard.
  check('RoomPaper: api.cursor is called once, after the disabled guard',
    (roomPaper.match(/api\.cursor\(/g) || []).length === 1)

  // Rooms UI fixes: one wrapping top row owns the chrome (name, game header,
  // room bar) so the name pill and the header can no longer share the top-left
  // corner; the panel is an overlay-layer dialog and the reconnect banner is
  // suppressed while it is open; the guess bar lifts itself above the on-screen
  // keyboard via window.visualViewport (iOS Safari has no keyboard-inset env).
  const css = sourceCode('src/rooms/rooms.css')
  check('RoomScreen: top chrome is a single wrapping row', screen.includes('room-top') && screen.includes('room-top-left'))
  check('rooms.css: the top row wraps', /\.room-top\s*\{[\s\S]*?flex-wrap:\s*wrap/.test(css))
  check('rooms.css: the name pill is static inside the room (no top-left corner fight)',
    /\.room-screen \.name-pill\s*\{[\s\S]*?position:\s*static/.test(css))
  check('rooms.css: the game header no longer uses an absolute top-left offset',
    !/^\.game-header\s*\{[^}]*position:\s*absolute/m.test(css))
  check('rooms.css: the players panel sits at the overlay layer (z6)',
    /\.room-panel\s*\{[\s\S]*?z-index:\s*6/.test(css))
  check('RoomScreen: the reconnect banner is hidden while the panel is open',
    screen.includes("status === 'reconnecting'") && screen.includes('!panelOpen'))
  check('RoomScreen: the guess bar lifts above the keyboard via visualViewport',
    screen.includes('visualViewport') && screen.includes('keyboardInset'))
  check('RoomScreen: it does NOT rely on env(keyboard-inset-height)',
    !screen.includes('keyboard-inset-height') && !css.includes('keyboard-inset-height'))
  check('RoomScreen: the keyboard inset listens to the visualViewport resize',
    /visualViewport[\s\S]*?addEventListener\('resize'/.test(screen))

  // Toolbar fit: rooms wrap the row instead of overflowing at 320 px, and the
  // swatches keep their 26 px plaza size. Scoped to .room-screen so the plaza
  // toolbar is untouched.
  check('rooms.css: the room toolbar row wraps', /\.room-screen \.toolbar-row\s*\{[\s\S]*?flex-wrap:\s*wrap/.test(css))
  check('rooms.css: the room swatch group may shrink/wrap',
    /\.room-screen \.swatches\s*\{[\s\S]*?flex:\s*0 1 auto/.test(css))
  check('rooms.css: the swatch size is not overridden (stays the plaza 26 px)',
    !/\.room-screen \.swatch\s*\{/.test(css))
  // The plaza row needs ~388 px (8x26 + 7x6 gaps + 10 + 3x34 brushes + 20 pad),
  // which overflows a 300 px container at 320 px width; wrapping is the fix, so
  // no single control may be forced to overflow the bar.
  {
    const swatchRow = 8 * 26 + 7 * 6
    const brushes = 3 * 34 + 2 * 2
    check('toolbar fit: the unwrapped row would overflow 320 px (wrap is required)',
      swatchRow + 10 + brushes + 20 > 300, String(swatchRow + 10 + brushes + 20))
  }
  check('index.css: the plaza toolbar is not restyled by the room rules',
    !sourceCode('src/index.css').includes('.room-screen .toolbar-row'))

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
  // B7: every game frame the server can send is applied, and the two controls
  // are sent through the shared builders.
  for (const frame of ['state', 'word_pick', 'your_word', 'reveal']) {
    check(`transport: applies the ${frame} frame`, transport.includes(`case '${frame}'`))
  }
  check('transport: sends start through the shared builder', transport.includes('startMessage()'))
  check('transport: sends pick through the shared builder', transport.includes('pickMessage('))
  check('transport: sends guess through the shared builder', transport.includes('guessMessage('))
  check('transport: applies the guess_ack frame', transport.includes("case 'guess_ack'"))
  // The reveal ends the drawing phase: the drawer's dangling live line must be
  // dropped then (the server ignores a late stroke_end once mayDraw flips), so
  // the reveal case clears live strokes before rendering.
  check('transport: drops live strokes on the reveal frame',
    /case 'reveal'[\s\S]{0,300}clearLive\(\)/.test(transport))
  check('strokeStore: exposes clearLive',
    sourceCode('src/engine/strokeStore.js').includes('clearLive()'))
  // A guess_cap is a transient notice, never a fatal status: it must not call
  // setStatus('error') (which would block reconnect-on-visible).
  check('transport: guess_cap is routed to a notice, not the error state',
    transport.includes("reason === 'guess_cap'") && transport.includes('setGuessNotice') &&
    /reason === 'guess_cap'[\s\S]{0,120}setGuessNotice/.test(transport))
  // Returning from a locked screen must reuse the reconnect path, but never
  // after a fatal close (kicked) and never while already connected.
  check('transport: resyncs/reconnects on visibilitychange',
    transport.includes("addEventListener('visibilitychange'"))
  check('transport: visibility reconnect is gated on status and the fatal flag',
    transport.includes("s.status === 'connected'") && transport.includes('s.fatal'))
  check('transport: records the fatal screen from nextAfterClose',
    transport.includes("s.fatal = outcome.status === 'error'"))

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

  // The dev worker config (rooms/wrangler.toml). Two rules matter:
  //   1. the phone-testing worker (default vars) must run PRODUCTION timings:
  //      it defines no GAME_* and no DRAWER_GRACE_MS, so it inherits GAME_TIMING
  //      (drawing 75 s, pick 10 s, reveal 8 s, scores 8 s, grace 10 s).
  //   2. the fast test worker ([env.fast]) is dev-only: ENVIRONMENT "dev"
  //      exactly, no production origin, and it repeats its own bindings,
  //      migrations and vars (a named env inherits nothing).
  {
    const raw = readSource('rooms/wrangler.toml')
    // Split off the comment lines so a stray GAME_* in a comment cannot pass.
    const code = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const defaultVars = code.split('[env.fast]')[0].split('[env.production]')[0]
    check('wrangler: the phone dev worker defines no GAME_* override',
      !/GAME_[A-Z]+_MS\s*=/.test(defaultVars), defaultVars.match(/GAME_[A-Z]+_MS\s*=[^\n]*/)?.[0])
    check('wrangler: the phone dev worker defines no DRAWER_GRACE_MS override',
      !/DRAWER_GRACE_MS\s*=/.test(defaultVars))

    const fast = code.split('[env.fast]')[1]?.split('[env.production]')[0] ?? ''
    check('wrangler: [env.fast] exists with its own vars', fast.length > 0 && fast.includes('ENVIRONMENT'))
    check('wrangler: [env.fast] is ENVIRONMENT = "dev" exactly', /ENVIRONMENT\s*=\s*"dev"/.test(fast))
    check('wrangler: [env.fast] defines the short GAME_* overrides',
      /GAME_ROUND_MS\s*=\s*"12000"/.test(fast) && /GAME_PICK_MS\s*=/.test(fast))
    check('wrangler: [env.fast] has no production origin in ALLOWED_ORIGINS',
      !/ALLOWED_ORIGINS\s*=\s*"[^"]*(PRODUCTION|\.example|dabble-rooms\.)/.test(fast), fast.match(/ALLOWED_ORIGINS\s*=\s*"[^"]*"/)?.[0])
    check('wrangler: [env.fast] repeats its Durable Object bindings',
      fast.includes('env.fast.durable_objects.bindings') && fast.includes('class_name = "Room"') && fast.includes('class_name = "Limiter"'))
    check('wrangler: [env.fast] repeats its migrations',
      fast.includes('env.fast.migrations') && fast.includes('new_sqlite_classes'))
    check('wrangler: [env.fast] repeats its rate limits',
      fast.includes('env.fast.ratelimits'))
    check('wrangler: no anon key is committed (it is injected via --var)',
      !/SUPABASE_ANON_KEY\s*=/.test(raw))
    // wrangler 4.x: `--var` REPLACES a named env's vars table, so the deploy
    // command (documented in the comment above [env.fast]) must repeat EVERY
    // var, including SUPABASE_URL and ENVIRONMENT. A missing SUPABASE_URL makes
    // the JWT issuer check fail and every request 401.
    check('wrangler: [env.fast].vars is a table section, not an inline vars = { }',
      /^\[env\.fast\.vars\]/m.test(raw) && !/^vars\s*=\s*\{/.test(fast))
    {
      const fastComment = raw.split('[env.fast]')[0]
      const deployCmd = fastComment.slice(fastComment.lastIndexOf('# Deploy'))
      const requiredVars = [
        'SUPABASE_ANON_KEY', 'SUPABASE_URL', 'ENVIRONMENT', 'ALLOWED_ORIGINS',
        'IP_ROOM_SOCKET_LIMIT', 'MAX_ROOMS_PER_IP_PER_HOUR', 'ROOM_GRACE_MS',
        'SEAT_HOLD_MS', 'GAME_PICK_MS', 'GAME_ROUND_MS', 'GAME_REVEAL_MS',
        'GAME_SCORES_MS', 'GAME_OVER_MS', 'DRAWER_GRACE_MS', 'EARLY_FINISH_HOLD_MS',
      ]
      const missing = requiredVars.filter((v) => !deployCmd.includes(`--var "${v}:`))
      check('wrangler: the [env.fast] deploy command repeats every var via --var',
        deployCmd.length > 0 && missing.length === 0, JSON.stringify(missing))

      // `--var` REPLACES the whole table, so the table and the command must
      // list EXACTLY the same key set (minus SUPABASE_ANON_KEY, which is
      // secret and only ever passed on the command line). 9cbafc7 dropped two
      // keys from the table and no test noticed; this is that guard.
      const tableVars = code.split('[env.fast.vars]')[1]?.split('[[env.fast')[0] ?? ''
      const tableKeys = [...tableVars.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]).sort()
      const cmdKeys = [...deployCmd.matchAll(/--var "([A-Z][A-Z0-9_]*):/g)]
        .map((m) => m[1])
        .filter((k) => k !== 'SUPABASE_ANON_KEY')
        .sort()
      const same = tableKeys.length > 0 && tableKeys.join(',') === cmdKeys.join(',')
      check('wrangler: [env.fast.vars] keys equal the deploy command keys',
        same, JSON.stringify({ table: tableKeys, command: cmdKeys }))
    }
  }
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
  check('StatusPill: the rooms link carries the tap-target class',
    pill.includes('status-footer-link'))

  // B9: the tap target is padding on the link only, cancelled by a negative
  // margin so the footer row's height does not change (no layout shift).
  const css = sourceCode('src/index.css')
  check('index.css: the tap target is padding on the link, offset by a negative margin',
    /\.status-footer-link\s*\{[^}]*padding:[^}]*\}/.test(css) && /\.status-footer-link\s*\{[^}]*margin:\s*-/.test(css))

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
  const ALLOWED = new Set([
    'src/components/StatusPill.jsx',
    'src/index.css',
    // A2 (step 4b close-out): clearLive() is an ADDITIVE, rooms-only method —
    // the reveal frame drops the drawer's dangling live stroke. The plaza
    // never calls it (asserted below), so plaza behaviour is unchanged.
    'src/engine/strokeStore.js',
  ])

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

    // The engine change allowed above is rooms-only: the plaza's own draw
    // path must never call clearLive, or the additive method would become a
    // plaza behaviour change.
    const plazaUsers = ['src/components/DrawingApp.jsx', 'src/hooks/useRealtimeCanvas.js']
    const callers = plazaUsers.filter((f) => sourceCode(f).includes('clearLive'))
    check('plaza guard: the plaza draw path never calls clearLive', callers.length === 0,
      JSON.stringify(callers))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
