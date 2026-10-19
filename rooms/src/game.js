// The pure drawing-game state machine: phases, turn rotation, hints, the
// secret word and the public frames. No I/O, no storage, no sockets — the Room
// DO owns saves, alarms and sends, which makes every transition here testable
// in plain Node.
//
// Phases: lobby -> pick -> drawing -> reveal -> scores -> (pick | game_over)
//         -> lobby. game in progress is the only state that holds a secret.
import { HINT_FRACTIONS, PHASES, TARGET_ROUNDS } from './config.js'
import { newRoundState, resetRoundState } from './round.js'

export function newGameState() {
  return {
    ...newRoundState(1),
    gameSeq: 0,
    phase: 'lobby',
    rounds: 0,
    order: [],
    drawerUserId: null,
    word: null,
    options: null,
    hintStep: 0,
    hintAts: [],
    correct: [],
    scores: {},
    skipped: false,
    phaseStartedAt: 0,
    phaseEndsAt: 0,
    deadlineAt: 0,
    drawerGraceAt: 0,
  }
}

/**
 * Backfill a stored room from an older schema (step-1 `room.game` was just
 * the round counters). Missing keys are added; existing ones — especially the
 * round counters — are never clobbered.
 */
export function upgradeGameState(existing) {
  const base = newGameState()
  const game = existing && typeof existing === 'object' ? existing : {}
  for (const [key, value] of Object.entries(base)) {
    if (!(key in game)) game[key] = value
  }
  if (!PHASES.includes(game.phase)) game.phase = 'lobby'
  if (!Array.isArray(game.order)) game.order = []
  if (!Array.isArray(game.hintAts)) game.hintAts = []
  if (!Array.isArray(game.correct)) game.correct = []
  if (!game.scores || typeof game.scores !== 'object' || Array.isArray(game.scores)) game.scores = {}
  return game
}

/** Turns and total rounds for a table of `n` players (6 rounds, as evenly split as possible). */
export function rotation(n) {
  const players = Math.max(1, Math.min(n, TARGET_ROUNDS + 6))
  const turns = Math.max(1, Math.ceil(TARGET_ROUNDS / players))
  return { turns, rounds: players * turns }
}

function drawerFor(game, round) {
  if (game.order.length === 0) return null
  return game.order[(round - 1) % game.order.length]
}

function setDeadline(game) {
  if (game.phase === 'drawing' && game.hintAts.length > game.hintStep) {
    const nextHint = game.hintAts[game.hintStep]
    game.deadlineAt = Math.min(nextHint, game.phaseEndsAt)
  } else {
    game.deadlineAt = game.phaseEndsAt
  }
}

function beginPick(game, round, now, times, options) {
  resetRoundState(game, round)
  game.phase = 'pick'
  game.drawerUserId = drawerFor(game, round)
  game.word = null
  game.options = Array.isArray(options) ? [...options] : []
  game.hintStep = 0
  game.hintAts = []
  game.correct = []
  game.skipped = false
  game.phaseStartedAt = now
  game.phaseEndsAt = now + times.pick
  game.drawerGraceAt = 0
  setDeadline(game)
}

function beginReveal(game, now, times, skipped) {
  game.phase = 'reveal'
  game.hintStep = 0
  game.hintAts = []
  game.skipped = !!skipped
  game.drawerGraceAt = 0
  game.phaseStartedAt = now
  game.phaseEndsAt = now + times.reveal
  setDeadline(game)
}

function beginScores(game, now, times) {
  game.phase = 'scores'
  game.phaseStartedAt = now
  game.phaseEndsAt = now + times.scores
  setDeadline(game)
}

function beginGameOver(game, now, times) {
  game.phase = 'game_over'
  game.word = null
  game.options = null
  game.hintStep = 0
  game.hintAts = []
  game.drawerGraceAt = 0
  game.phaseStartedAt = now
  game.phaseEndsAt = now + times.gameOver
  setDeadline(game)
}

function beginDrawing(game, word, now, times) {
  game.word = word
  game.options = null
  game.phase = 'drawing'
  game.hintStep = 0
  game.hintAts = HINT_FRACTIONS.map((f) => now + Math.round(times.drawing * f))
  game.skipped = false
  game.phaseStartedAt = now
  game.phaseEndsAt = now + times.drawing
  game.drawerGraceAt = 0
  setDeadline(game)
}

/** Start a game: fixed turn order, round 1, the first drawer picks. */
export function startGame(game, userIds, now, times, options) {
  game.gameSeq += 1
  game.order = [...new Set(userIds)]
  game.rounds = rotation(game.order.length).rounds
  game.scores = {}
  beginPick(game, 1, now, times, options)
  return game
}

/**
 * Enter the drawing phase with the drawer's choice. Invalid choices never
 * reach here (the wire + DO guard), but a missing choice degrades to a skipped
 * reveal instead of a stuck round.
 */
export function acceptPick(game, index, now, times) {
  if (game.phase !== 'pick') return null
  const word = game.options?.[index]
  if (typeof word !== 'string') return null
  beginDrawing(game, word, now, times)
  return word
}

/** Drawer vanished, was kicked, or never picked: reveal what can be shown. */
export function skipRound(game, now, times) {
  if (game.phase !== 'pick' && game.phase !== 'drawing') return false
  beginReveal(game, now, times, true)
  return true
}

/**
 * One alarm step. Returns { from, to, event } for logging/side effects. The
 * caller clears the old round's strokes before a scores->pick advance (the
 * round number changes here) and before deleting a game (lobby).
 */
export function advance(game, now, times, options = []) {
  const from = game.phase

  if (from === 'pick') {
    const word = game.options?.[0]
    if (typeof word === 'string') beginDrawing(game, word, now, times)
    else beginReveal(game, now, times, true)
    return { from, to: game.phase, event: 'pick_auto' }
  }

  if (from === 'drawing') {
    if (now >= game.phaseEndsAt) {
      beginReveal(game, now, times, false)
      return { from, to: game.phase, event: 'timeout' }
    }
    if (game.hintStep < game.hintAts.length && now >= game.hintAts[game.hintStep]) {
      game.hintStep += 1
      setDeadline(game)
      return { from, to: game.phase, event: 'hint' }
    }
    setDeadline(game)
    return { from, to: game.phase, event: 'none' }
  }

  if (from === 'reveal') {
    beginScores(game, now, times)
    return { from, to: game.phase, event: 'phase' }
  }

  if (from === 'scores') {
    if (game.round < game.rounds) {
      beginPick(game, game.round + 1, now, times, options)
      return { from, to: game.phase, event: 'phase' }
    }
    beginGameOver(game, now, times)
    return { from, to: game.phase, event: 'phase' }
  }

  if (from === 'game_over') {
    toLobby(game)
    return { from, to: game.phase, event: 'phase' }
  }

  return { from, to: game.phase, event: 'none' }
}

/** Back to the lobby, dropping every secret and per-game counter. */
export function toLobby(game) {
  resetRoundState(game, 1)
  game.phase = 'lobby'
  game.rounds = 0
  game.order = []
  game.drawerUserId = null
  game.word = null
  game.options = null
  game.hintStep = 0
  game.hintAts = []
  game.correct = []
  game.scores = {}
  game.skipped = false
  game.phaseStartedAt = 0
  game.phaseEndsAt = 0
  game.deadlineAt = 0
  game.drawerGraceAt = 0
  return game
}

/** Does this phase hold/handle the secret word for the drawer? */
export function isSecretPhase(phase) {
  return phase === 'pick' || phase === 'drawing'
}

export function isDrawerPhase(phase) {
  return phase === 'pick' || phase === 'drawing'
}

/**
 * Masked word for the public state frame: never the word itself. Step 0 is all
 * underscores; each hint reveals ~50% then ~75% of the letters (never all).
 */
export function hintFor(word, step) {
  if (typeof word !== 'string' || word.length === 0) return null
  const chars = [...word]
  if (!step) return chars.map((c) => (c === ' ' ? ' ' : '_')).join('')
  const k = Math.min(chars.length - 1, Math.max(1, Math.floor(chars.length * HINT_FRACTIONS[step - 1])))
  const revealed = new Set()
  for (let j = 1; j <= k; j++) {
    revealed.add(Math.min(chars.length - 1, Math.floor((j * chars.length) / (k + 1))))
  }
  return chars.map((c, i) => (c === ' ' ? ' ' : revealed.has(i) ? c : '_')).join('')
}

/** Public per-round state. Always safe to broadcast (no secret word). */
export function stateFrame(game, now) {
  const secret = isSecretPhase(game.phase)
  return {
    v: 1,
    t: 'state',
    round: game.round,
    rounds: game.rounds,
    phase: game.phase,
    remainingMs: game.phaseEndsAt ? Math.max(0, game.phaseEndsAt - now) : 0,
    drawer: game.drawerUserId,
    wordLen: secret && game.word ? [...game.word].length : null,
    hint: secret && game.word ? hintFor(game.word, game.hintStep) : null,
    scores: game.scores,
    correct: game.correct,
  }
}

/** Drawer-only frames. Targeted sends; never broadcast. */
export function wordPickFrame(game) {
  return { v: 1, t: 'word_pick', round: game.round, options: game.options ? [...game.options] : [] }
}

export function yourWordFrame(game) {
  return { v: 1, t: 'your_word', round: game.round, word: game.word }
}

/** Public reveal (the moment the word may be broadcast). */
export function revealFrame(game) {
  return {
    v: 1,
    t: 'reveal',
    round: game.round,
    word: game.word,
    correct: game.correct,
    skipped: game.skipped,
  }
}

/**
 * The one secret gate on every broadcast. `reveal` is the only frame allowed
 * to carry a word; any future frame that grows one is dropped and logged
 * instead of silently leaking.
 */
export function secretsAllowed(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (obj.t === 'reveal') return true
  if ('word' in obj || 'words' in obj || 'options' in obj || 'revealWord' in obj) return false
  return true
}

/**
 * Targeted sends to the drawer are the only other place a secret may go.
 * Deliberately separate from secretsAllowed so a future broadcast cannot pick
 * these up by accident.
 */
export function targetedSecretsAllowed(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (obj.t === 'word_pick' || obj.t === 'your_word') return true
  return secretsAllowed(obj)
}
