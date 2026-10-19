// Unit tests for the v2 Phase 3 step 2 game state machine: rotation, phases,
// hints, the secret gate and the public frames. Pure, no network.
//
//   node tests/game-unit.test.mjs
import { GAME_TIMING, HINT_FRACTIONS, PHASES, TARGET_ROUNDS, WORD_OPTIONS, gameTimings } from '../src/config.js'
import {
  acceptPick,
  advance,
  isDrawerPhase,
  isSecretPhase,
  newGameState,
  revealFrame,
  rotation,
  secretsAllowed,
  skipRound,
  startGame,
  stateFrame,
  targetedSecretsAllowed,
  toLobby,
  upgradeGameState,
  wordPickFrame,
  yourWordFrame,
  hintFor,
} from '../src/game.js'
import { pickWords, WORDS } from '../src/words.js'
import { check, summary } from './helpers.mjs'

const TIMES = { pick: 10000, drawing: 60000, reveal: 8000, scores: 8000, gameOver: 30000, drawerGrace: 10000 }
const T0 = 1_000_000
const PLAYERS = ['u1', 'u2', 'u3']

// ---- rotation ---------------------------------------------------------------
{
  const cases = [
    [2, 3, 6], [3, 2, 6], [4, 2, 8], [5, 2, 10], [6, 1, 6], [7, 1, 7], [12, 1, 12],
  ]
  for (const [n, turns, rounds] of cases) {
    const r = rotation(n)
    check(`rotation: ${n} players -> ${turns} turn(s) each, ${rounds} rounds`,
      r.turns === turns && r.rounds === rounds, JSON.stringify(r))
  }
  check('rotation: target rounds is 6', TARGET_ROUNDS === 6)
  check('rotation: every table gives each player the same number of turns',
    [2, 3, 4, 5, 6, 7, 12].every((n) => rotation(n).rounds % n === 0))
}

// ---- words ------------------------------------------------------------------
{
  check('words: at least 50 prompts', WORDS.length >= 50, String(WORDS.length))
  check('words: all lowercase single tokens', WORDS.every((w) => /^[a-z]+$/.test(w)))
  check('words: no duplicates', new Set(WORDS).size === WORDS.length)
  check('words: frozen', Object.isFrozen(WORDS))
  const picked = pickWords(WORD_OPTIONS, () => 0.5)
  check(`words: pickWords returns ${WORD_OPTIONS} distinct`, picked.length === WORD_OPTIONS && new Set(picked).size === WORD_OPTIONS, JSON.stringify(picked))
  check('words: pickWords is deterministic with an injected rng',
    JSON.stringify(pickWords(3, () => 0)) === JSON.stringify(pickWords(3, () => 0)))
}

// ---- start -> pick ----------------------------------------------------------
{
  const g = newGameState()
  check('start: a new room is in the lobby at round 1', g.phase === 'lobby' && g.round === 1 && g.rounds === 0)
  check('start: lobby holds no secret', g.word === null && g.options === null)

  startGame(g, PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  check('start: round 1, phase pick', g.round === 1 && g.phase === 'pick')
  check('start: rounds from rotation', g.rounds === 6)
  check('start: turn order is the requested seat order', JSON.stringify(g.order) === JSON.stringify(PLAYERS))
  check('start: first drawer is order[0]', g.drawerUserId === 'u1')
  check('start: options are held server-side', JSON.stringify(g.options) === '["a","b","c"]')
  check('start: no word before the pick', g.word === null)
  check('start: deadline is the pick deadline', g.deadlineAt === T0 + TIMES.pick, String(g.deadlineAt))
  check('start: gameSeq advances', g.gameSeq === 1)

  const pick = wordPickFrame(g)
  check('word_pick: carries the round and options', pick.round === 1 && JSON.stringify(pick.options) === '["a","b","c"]')

  const state = stateFrame(g, T0 + 1000)
  check('state: pick frame hides the word', state.phase === 'pick' && state.wordLen === null && state.hint === null)
  check('state: remaining counts down from the phase end', state.remainingMs === TIMES.pick - 1000, String(state.remainingMs))
  check('state: scores/correct are empty in step 2', JSON.stringify(state.scores) === '{}' && state.correct.length === 0)
  check('state: is safe to broadcast', secretsAllowed(state))
}

// ---- reject / accept picks --------------------------------------------------
{
  const g = startGame(newGameState(), PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  check('pick: invalid index rejected', acceptPick(g, 3, T0 + 10, TIMES) === null)
  check('pick: negative index rejected', acceptPick(g, -1, T0 + 10, TIMES) === null)
  check('pick: non-integer rejected', acceptPick(g, 1.5, T0 + 10, TIMES) === null)
  check('pick: still picking after bad input', g.phase === 'pick')

  const t = T0 + 2000
  const word = acceptPick(g, 1, t, TIMES)
  check('pick: accepts a valid choice', word === 'b')
  check('pick: drawing starts and the word is stored', g.phase === 'drawing' && g.word === 'b')
  check('pick: options are dropped once picked', g.options === null)
  check('pick: reset counters for the new round', g.seq === 0 && g.count === 0 && g.points === 0)
  check('pick: hints at 50% and 75%', JSON.stringify(g.hintAts) === JSON.stringify([t + 30000, t + 45000]))
  check('pick: deadline is the first hint', g.deadlineAt === t + 30000, String(g.deadlineAt))
  check('pick: your_word carries the word to the drawer', yourWordFrame(g).word === 'b')

  const state = stateFrame(g, t + 100)
  check('state: drawing exposes length + masked hint, not the word',
    state.wordLen === 1 && state.hint === '_' && !JSON.stringify(state).includes('"b"'), JSON.stringify(state))
  check('state: drawer is public', state.drawer === 'u1')
}

// ---- hints ------------------------------------------------------------------
{
  check('hint: step 0 is all underscores', hintFor('pizza', 0) === '_____')
  const h1 = hintFor('pizza', 1)
  const h2 = hintFor('pizza', 2)
  check('hint: step 1 reveals some letters and masks the rest', /^[a-z_]{5}$/.test(h1) && h1.includes('_') && h1 !== '_____', h1)
  check('hint: step 2 reveals more than step 1',
    [...h2].filter((c) => c !== '_').length > [...h1].filter((c) => c !== '_').length, `${h1} -> ${h2}`)
  check('hint: never reveals the whole word', h1 !== 'pizza' && h2 !== 'pizza')
  check('hint: length always equals the word', ['a', 'hi', 'pizza', 'lighthouse'].every((w) => hintFor(w, 0).length === w.length))
  check('hint: fractions are the configured two', HINT_FRACTIONS.length === 2)

  const g = startGame(newGameState(), PLAYERS, T0, TIMES, ['pizza', 'b', 'c'])
  acceptPick(g, 0, T0, TIMES)
  const t1 = T0 + TIMES.drawing * HINT_FRACTIONS[0]
  const r1 = advance(g, t1, TIMES)
  check('hints: the first alarm reveals hint 1', r1.event === 'hint' && g.hintStep === 1, JSON.stringify(r1))
  check('hints: next alarm is the second hint', g.deadlineAt === T0 + TIMES.drawing * HINT_FRACTIONS[1], String(g.deadlineAt))
  const r2 = advance(g, g.deadlineAt, TIMES)
  check('hints: the second alarm reveals hint 2', r2.event === 'hint' && g.hintStep === 2, JSON.stringify(r2))
  check('hints: after the last hint the alarm is the phase end', g.deadlineAt === g.phaseEndsAt, String(g.deadlineAt))
  check('hints: still drawing after both hints', g.phase === 'drawing' && g.word === 'pizza')
}

// ---- timeout / reveal / scores / next round --------------------------------
{
  const g = startGame(newGameState(), PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  acceptPick(g, 0, T0, TIMES)
  const end = T0 + TIMES.drawing
  const r = advance(g, end, TIMES)
  check('timeout: drawing ends in reveal', r.to === 'reveal' && g.phase === 'reveal')
  check('timeout: not skipped and the word is public now', g.skipped === false && g.word === 'a')
  const rev = revealFrame(g)
  check('reveal: carries the word and skipped flag', rev.word === 'a' && rev.skipped === false)
  check('reveal: is allowed to broadcast', secretsAllowed(rev))
  check('reveal: state hint is gone', stateFrame(g, end).hint === null)

  const rs = advance(g, g.phaseEndsAt, TIMES)
  check('reveal: goes to scores', rs.to === 'scores' && g.phase === 'scores')

  const next = advance(g, g.phaseEndsAt, TIMES, ['x', 'y', 'z'])
  check('scores: next round is pick', next.to === 'pick' && g.phase === 'pick' && g.round === 2)
  check('scores: round counters reset for the new round', g.seq === 0 && g.points === 0 && g.partial === false)
  check('scores: drawer rotates to order[1]', g.drawerUserId === 'u2')
  check('scores: previous word is cleared at the new pick', g.word === null)
  check('scores: new options are held', JSON.stringify(g.options) === '["x","y","z"]')
  check('scores: no round-clear secret leaked in state', stateFrame(g, g.deadlineAt).wordLen === null)
}

// ---- game over -> lobby -----------------------------------------------------
{
  const g = startGame(newGameState(), ['a', 'b'], T0, TIMES, ['x', 'y', 'z'])
  let now = T0
  // Walk every round without waiting: pick, draw out, reveal out, scores out.
  for (let round = 1; round <= g.rounds; round++) {
    if (g.phase === 'pick') now = g.deadlineAt
    advance(g, now, TIMES)
    // draw the full phase (acceptPick already ran via auto-pick)
    now = g.phaseEndsAt
    advance(g, now, TIMES) // reveal
    now = g.phaseEndsAt
    advance(g, now, TIMES) // scores
    now = g.phaseEndsAt
    const res = advance(g, now, TIMES, ['x', 'y', 'z'])
    if (round < g.rounds) {
      check(`game: round ${round} -> round ${round + 1} pick`, res.to === 'pick' && g.round === round + 1)
    } else {
      check('game: after the last round the game is over', res.to === 'game_over' && g.phase === 'game_over')
    }
  }
  check('game over: the word is dropped', g.word === null && g.options === null)
  check('game over: broadcast state is safe', secretsAllowed(stateFrame(g, now)))
  const lobby = advance(g, g.phaseEndsAt, TIMES)
  check('game over: returns to lobby', lobby.to === 'lobby' && g.phase === 'lobby')
  check('lobby: no word, no options, no order, no rounds',
    g.word === null && g.options === null && g.order.length === 0 && g.rounds === 0)
  check('lobby: counters and round reset', g.round === 1 && g.seq === 0 && g.points === 0)
  check('lobby: gameSeq is kept for scoped keys', g.gameSeq === 1, String(g.gameSeq))
}

// ---- drawer absence / skip --------------------------------------------------
{
  const g = startGame(newGameState(), PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  check('skip: picking player skipped -> reveal, no word', skipRound(g, T0 + 1, TIMES) && g.phase === 'reveal' && g.word === null && g.skipped === true)
  check('skip: reveal frame may carry a null word', revealFrame(g).word === null)
  check('skip: cannot skip outside a drawer phase', skipRound(g, T0 + 2, TIMES) === false)

  const g2 = startGame(newGameState(), PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  acceptPick(g2, 2, T0, TIMES)
  check('skip: drawing drawer skipped -> reveal keeps the word', skipRound(g2, T0 + 1, TIMES) && g2.word === 'c' && g2.skipped === true)

  check('phases: only pick/drawing are drawer/secret phases',
    isDrawerPhase('pick') && isDrawerPhase('drawing') &&
    !isDrawerPhase('reveal') && !isDrawerPhase('scores') && !isDrawerPhase('lobby') &&
    isSecretPhase('pick') && isSecretPhase('drawing') && !isSecretPhase('reveal'))
}

// ---- secret gate ------------------------------------------------------------
{
  check('gate: state is allowed', secretsAllowed({ v: 1, t: 'state', round: 1 }))
  check('gate: reveal is allowed', secretsAllowed({ v: 1, t: 'reveal', word: 'pizza' }))
  check('gate: a state carrying a word is blocked', secretsAllowed({ v: 1, t: 'state', word: 'pizza' }) === false)
  check('gate: options in a broadcast are blocked', secretsAllowed({ v: 1, t: 'state', options: ['a'] }) === false)
  check('gate: words array is blocked', secretsAllowed({ v: 1, t: 'snapshot', words: [] }) === false)
  check('gate: targeted your_word is allowed only by the targeted gate',
    targetedSecretsAllowed({ v: 1, t: 'your_word', word: 'pizza' }) && !secretsAllowed({ v: 1, t: 'your_word', word: 'pizza' }))
  check('gate: targeted word_pick allowed only by the targeted gate',
    targetedSecretsAllowed(wordPickFrame({ round: 1, options: ['a'] })) && !secretsAllowed(wordPickFrame({ round: 1, options: ['a'] })))
  check('gate: unknown object rejected', secretsAllowed(null) === false && secretsAllowed('x') === false)
}

// ---- upgrade from step 1 ----------------------------------------------------
{
  const old = { round: 4, seq: 7, count: 6, points: 900, bytes: 5000, partial: true }
  const up = upgradeGameState(old)
  check('upgrade: keeps the step-1 round counters',
    up.round === 4 && up.seq === 7 && up.count === 6 && up.points === 900 && up.partial === true,
    JSON.stringify(up))
  check('upgrade: adds a lobby game', up.phase === 'lobby' && up.gameSeq === 0 && up.order.length === 0)
  check('upgrade: clamps an unknown phase to lobby', upgradeGameState({ phase: 'dance' }).phase === 'lobby')
  check('upgrade: missing object yields a fresh game', upgradeGameState(undefined).phase === 'lobby')
  check('upgrade: all phases are known', Object.isFrozen(PHASES) && PHASES.length === 6)
}

// ---- frame shape ------------------------------------------------------------
{
  const g = startGame(newGameState(), PLAYERS, T0, TIMES, ['a', 'b', 'c'])
  const st = stateFrame(g, T0)
  check('frame: state has the wire fields',
    st.v === 1 && st.t === 'state' && typeof st.round === 'number' && typeof st.rounds === 'number' &&
    typeof st.phase === 'string' && typeof st.remainingMs === 'number' && st.scores && Array.isArray(st.correct))
  check('frame: state never carries options or word', !('word' in st) && !('options' in st))
  const wp = wordPickFrame(g)
  check('frame: word_pick is v1', wp.v === 1 && wp.t === 'word_pick')
  const toLobbied = toLobby(g)
  check('frame: lobby state has no drawer and zero remaining', stateFrame(toLobbied, T0).drawer === null && stateFrame(toLobbied, T0).remainingMs === 0)
}

// ---- phase timings: dev-only env overrides ---------------------------------
{
  check('timings: production defaults are the spec values',
    GAME_TIMING.pick === 10000 && GAME_TIMING.drawing === 60000 && GAME_TIMING.reveal === 8000 &&
    GAME_TIMING.scores === 8000 && GAME_TIMING.gameOver === 30000 && GAME_TIMING.drawerGrace === 10000,
    JSON.stringify(GAME_TIMING))

  const dev = { ENVIRONMENT: 'dev', GAME_PICK_MS: '1000', GAME_ROUND_MS: '5000', DRAWER_GRACE_MS: '2500' }
  const overridden = gameTimings(dev)
  check('timings: dev overrides apply under ENVIRONMENT=dev',
    overridden.pick === 1000 && overridden.drawing === 5000 && overridden.drawerGrace === 2500,
    JSON.stringify(overridden))

  // Anything that is not exactly 'dev' must ignore every override, the same
  // rule as X-Test-IP (rooms/src/hash.js) and SIMULATE_QUOTA.
  const notDev = ['production', 'Development', 'dev ', 'DEV', 'staging', undefined, '', 'prod']
  for (const value of notDev) {
    const t = gameTimings({ ENVIRONMENT: value, GAME_ROUND_MS: '1', DRAWER_GRACE_MS: '1' })
    check(`timings: ENVIRONMENT=${JSON.stringify(value)} ignores the overrides`,
      t.drawing === GAME_TIMING.drawing && t.drawerGrace === GAME_TIMING.drawerGrace, JSON.stringify(t))
  }
  check('timings: an empty env is production defaults', JSON.stringify(gameTimings()) === JSON.stringify(GAME_TIMING))

  // Clamping keeps a typo from freezing a game or creating a zero phase.
  const clamped = gameTimings({ ENVIRONMENT: 'dev', GAME_PICK_MS: '0', GAME_ROUND_MS: '999999999', GAME_REVEAL_MS: 'not-a-number' })
  check('timings: out-of-range and junk values fall back to the default',
    clamped.pick === GAME_TIMING.pick && clamped.drawing === GAME_TIMING.drawing && clamped.reveal === GAME_TIMING.reveal,
    JSON.stringify(clamped))
  const edge = gameTimings({ ENVIRONMENT: 'dev', GAME_PICK_MS: '500', GAME_ROUND_MS: '3600000' })
  check('timings: the clamp boundaries themselves are accepted',
    edge.pick === 500 && edge.drawing === 3600000, JSON.stringify(edge))
}

// ---- table shape for N = 2..12 (design guard, not a product limit) ----------
{
  // R = N x T with T = ceil(6/N): R is 6 for N<=6, then grows with N. This is
  // the deliberate "everyone draws at least once" shape; the durations/alarm
  // counts are projections at production timings, printed in the step summary.
  const expected = { 2: 6, 3: 6, 4: 8, 5: 10, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12 }
  for (const [n, rounds] of Object.entries(expected)) {
    const r = rotation(Number(n))
    check(`table: N=${n} plays ${rounds} rounds`, r.rounds === rounds, JSON.stringify(r))
    check(`table: N=${n} divides evenly`, r.rounds % Number(n) === 0)
  }
  check('table: the design has no player cap of 6', rotation(12).rounds === 12)
}

summary('game-unit')
