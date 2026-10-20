import { useEffect, useMemo, useRef, useState } from 'react'
import { createCursorStore } from '../engine/cursorStore.js'
import { createStrokeStore } from '../engine/strokeStore.js'
import { flagEmoji } from '../lib/country.js'
import { loadIdentity } from '../lib/identity.js'
import { copyText } from './roomsClipboard.js'
import { RETRYABLE_ERRORS, ROOM_ERROR_COPY } from './roomsErrors.js'
import { ROOM_GUESS_SEND_DISABLE_MS, MAX_GUESS_LENGTH, MIN_PLAYERS } from './roomsConfig.js'
import { gainRows, playerTotal, standings } from './roomsScores.js'
import RoomPaper from './RoomPaper.jsx'
import { useRoomTransport } from './useRoomTransport.js'

const RETRYABLE = new Set(RETRYABLE_ERRORS)

export default function RoomScreen({ roomsUrl, code, onLeave }) {
  const store = useMemo(() => createStrokeStore(), [])
  const cursors = useMemo(() => createCursorStore(), [])
  const fallbackIdentity = useMemo(() => loadIdentity(), [])
  const redrawRef = useRef(() => {})

  const [copied, setCopied] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [kickToast, setKickToast] = useState(null)
  const codeRef = useRef(null)

  const { api, status, ready, error, players, seat, isHost, kickNotice, game, wordPick, yourWord, reveal, guessAck, guessNotice } =
    useRoomTransport({
      roomsUrl,
      code,
      store,
      cursors,
      onVisualChange: () => redrawRef.current(),
    })

  // The server derives the display name from the player's own `players` row,
  // so once we know which entry is ours, that is the identity the strokes
  // should carry — otherwise our view of our own line differs from everyone
  // else's. Before `welcome` arrives there is nothing to derive, and drawing
  // is disabled anyway.
  const identity = useMemo(() => {
    const me = seat === null ? null : players.find((p) => p.seat === seat)
    return me ? { id: me.userId, name: me.name } : fallbackIdentity
  }, [players, seat, fallbackIdentity])

  // Our server-side userId, used to tell whether the public `drawer` is us.
  const myUserId = seat === null ? null : players.find((p) => p.seat === seat)?.userId ?? null
  const isDrawer = !!game && myUserId !== null && game.drawer === myUserId
  const drawerName = useMemo(() => {
    if (!game?.drawer) return null
    return players.find((p) => p.userId === game.drawer)?.name ?? 'Someone'
  }, [game, players])

  // Only the drawer paints during a round; with no game running the room is a
  // free-draw canvas (the plaza stays the lobby). This mirrors the server's
  // mayDraw exactly: a non-drawer's paper is read-only, and its toolbar is
  // hidden rather than shown dead.
  const inGame = !!game && game.phase !== 'lobby'
  const canDraw = ready && (!inGame || (game.phase === 'drawing' && isDrawer))

  // Guessing (step 4a): a non-drawer may guess while a round is drawing, until
  // they have guessed correctly. The server is the authority; this only decides
  // what the screen offers.
  const haveGuessed = !!game && myUserId !== null && (game.correct ?? []).includes(myUserId)
  const canGuess = ready && !!game && game.phase === 'drawing' && !isDrawer && !haveGuessed
  const correctNames = useMemo(() => {
    if (!game?.correct?.length) return []
    return game.correct.map((uid) => players.find((p) => p.userId === uid)?.name ?? 'Someone')
  }, [game, players])

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!kickNotice) return undefined
    setKickToast(kickNotice)
    const timer = setTimeout(() => setKickToast(null), 4000)
    return () => clearTimeout(timer)
  }, [kickNotice])

  const copyCode = async () => {
    const outcome = await copyText(code, { target: codeRef.current })
    if (outcome !== 'failed') setCopied(true)
  }

  const leave = () => {
    api.leave()
    onLeave()
  }

  const isError = status === 'error' && error

  return (
    <div className="room-screen">
      <RoomPaper
        store={store}
        cursors={cursors}
        api={api}
        identity={identity}
        disabled={!canDraw}
        redrawRef={redrawRef}
      />

      <div className="room-top">
        <div className="room-top-left">
          <span className="name-pill">
            <span className="name-button" title="You">
              {identity.name}
            </span>
          </span>
          <GameHeader
            game={game}
            ready={ready}
            isHost={isHost}
            isDrawer={isDrawer}
            drawerName={drawerName}
            playerCount={players.length}
            players={players}
            wordPick={wordPick}
            yourWord={yourWord}
            reveal={reveal}
            onStart={() => api.start()}
            onPick={(i) => api.pick(i)}
          />
        </div>

        <div className="room-bar">
          <span className="status-pill">
            <span
              className={`status-dot ${
                status === 'connected' ? 'status-dot-live' : status === 'error' ? 'status-dot-down' : 'status-dot-warn'
              }`}
            />
            {statusLabel(status, ready, error)}
          </span>

          <span className="room-code-chip">
            <span ref={codeRef} className="room-code">
              {code}
            </span>
            <button type="button" className="room-copy" onClick={copyCode}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </span>

          <button
            type="button"
            className="room-pill-button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
          >
            {players.length} in room
          </button>

          <button type="button" className="room-pill-button" onClick={leave}>
            Leave
          </button>
        </div>
      </div>

      <GuessBar
        canGuess={canGuess}
        haveGuessed={haveGuessed}
        ack={guessAck}
        notice={guessNotice}
        correctNames={correctNames}
        onGuess={(text) => api.guess(text)}
      />

      {panelOpen && (
        <div className="room-panel" role="dialog" aria-label="Players">
          <div className="room-panel-head">
            <strong>Players</strong>
            <button type="button" className="room-panel-close" onClick={() => setPanelOpen(false)}>
              Close
            </button>
          </div>
          <ul className="room-player-list">
            {players.map((player) => {
              const mine = player.seat === seat
              // The current total is the server's, read from the latest state
              // frame by userId; null before a frame arrives (render nothing).
              const total = playerTotal(game, player.userId)
              return (
                <li key={player.userId} className="room-player">
                  <span className="room-player-name" title={player.country ?? undefined}>
                    {player.name}
                    {mine ? ' (you)' : ''}
                  </span>
                  {player.host && <span className="room-host-badge">host</span>}
                  {total !== null && <span className="room-player-score">{total}</span>}
                  {isHost && !mine && (
                    <button
                      type="button"
                      className="room-kick"
                      onClick={() => {
                        api.kick(player.userId)
                        setPanelOpen(false)
                      }}
                    >
                      Kick
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {kickToast && (
        <div className={`room-toast ${kickToast.ok ? '' : 'room-toast-warn'}`} role="status">
          {kickToast.ok
            ? 'Player kicked'
            : kickToast.reason === 'self'
              ? 'You cannot kick yourself'
              : 'Player already left'}
        </div>
      )}


      {status === 'reconnecting' && !isError && !panelOpen && (
        <div className="room-banner" role="status">
          Reconnecting…
        </div>
      )}

      {isError && (
        <div className="room-overlay">
          <div className="room-overlay-card">
            <p>{ROOM_ERROR_COPY[error] ?? ROOM_ERROR_COPY.join_failed}</p>
            <div className="room-overlay-actions">
              {RETRYABLE.has(error) && (
                <button type="button" className="room-primary" onClick={() => api.retry()}>
                  Try again
                </button>
              )}
              <button type="button" className="room-secondary" onClick={leave}>
                Back to rooms
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function statusLabel(status, ready, error) {
  if (status === 'error') return 'Offline'
  if (status === 'connected') return ready ? 'Live' : 'Joining'
  if (status === 'reconnecting') return 'Reconnecting'
  if (status === 'connecting') return 'Joining'
  return error ? 'Offline' : 'Idle'
}

/**
 * The countdown derives everything from the server's `remainingMs` and the
 * local clocks: it never compares a server timestamp with Date.now() (clocks
 * disagree), and it resyncs on every state frame. Elapsed is the larger of the
 * monotonic delta and the wall-clock delta measured on THIS device, so a clock
 * that freezes while the device sleeps (iOS Safari) cannot make the countdown
 * stall. The displayed value is clamped to [0, remainingMs] of the latest
 * frame. A visibilitychange resync covers the case where the interval was
 * throttled while the page was hidden.
 */
function Countdown({ game }) {
  const [left, setLeft] = useState(() => remaining(game))

  useEffect(() => {
    const sync = () => setLeft(remaining(game))
    sync()
    if (!game || game.remainingMs <= 0) return undefined
    const timer = setInterval(sync, 250)
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [game])

  if (!game || game.remainingMs <= 0) return null
  return <span className="game-clock">{Math.ceil(left / 1000)}s</span>
}

function remaining(game) {
  if (!game) return 0
  const mono = performance.now() - game.at
  const wall = typeof game.atWall === 'number' ? Date.now() - game.atWall : 0
  return Math.min(game.remainingMs, Math.max(0, Math.max(mono, wall)))
}

/**
 * How many pixels the on-screen keyboard covers at the bottom, for laying the
 * guess bar above it. iOS Safari does not support `env(keyboard-inset-height)`
 * (nor `interactive-widget`), so we read `window.visualViewport`: the keyboard
 * overlap is the layout viewport height minus the visible visual viewport,
 * minus any `offsetTop` (iOS also scrolls the visual viewport). Listening to
 * the viewport's `resize`/`scroll` is the only reliable signal on iOS; the
 * listener is torn down with the component. Returns 0 when there is no
 * visualViewport API (older browsers) or no keyboard, so the CSS default
 * (`bottom: max(12px, safe-area-inset-bottom)`) still applies.
 */
function useKeyboardInset() {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return undefined
    const update = () => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop
      setInset(Math.max(0, Math.round(overlap)))
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}

/**
 * The guess control and its private feedback (v2 Phase 3 step 4a). Only the
 * guesser ever sees the outcome; other players only learn that someone guessed
 * via the public `correct` list, which never carries the text. The send button
 * is disabled for ROOM_GUESS_SEND_DISABLE_MS after a guess so a fast tapper
 * cannot outrun the server's 2/s guess budget.
 */
function GuessBar({ canGuess, haveGuessed, ack, notice, correctNames, onGuess }) {
  const [text, setText] = useState('')
  const [lockedUntil, setLockedUntil] = useState(0)
  const [tick, setTick] = useState(0)
  const inputRef = useRef(null)
  const keyboardInset = useKeyboardInset()

  useEffect(() => {
    if (lockedUntil <= Date.now()) return undefined
    const timer = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(timer)
  }, [lockedUntil])

  if (!canGuess && !haveGuessed && !correctNames.length) return null

  const locked = Date.now() < lockedUntil
  const submit = (event) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || locked) return
    onGuess(value)
    setText('')
    setLockedUntil(Date.now() + ROOM_GUESS_SEND_DISABLE_MS)
    setTick((n) => n + 1)
    inputRef.current?.focus()
  }

  return (
    <div className="game-guess" style={keyboardInset > 0 ? { bottom: `${keyboardInset}px` } : undefined}>
      {correctNames.length > 0 && (
        <div className="game-guess-correct" role="status">
          {correctNames.length === 1 ? `${correctNames[0]} guessed it` : `${correctNames.length} guessed it`}
        </div>
      )}
      {canGuess ? (
        <form className="game-guess-form" onSubmit={submit}>
          <input
            ref={inputRef}
            className="game-guess-input"
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type your guess…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-label="Your guess"
            maxLength={MAX_GUESS_LENGTH}
          />
          <button type="submit" className="room-primary" disabled={locked || text.trim().length === 0}>
            Guess
          </button>
        </form>
      ) : haveGuessed ? (
        <div className="game-guess-feedback game-guess-ok" role="status">
          You guessed it
        </div>
      ) : null}
      {ack && ack.ok === false && (
        <div className={`game-guess-feedback ${ack.close ? 'game-guess-close' : ''}`} role="status" key={ack.at}>
          {ack.close ? 'Close!' : 'Not quite'}
        </div>
      )}
      {notice?.reason === 'guess_cap' && (
        <div className="game-guess-feedback" role="status" key={notice.at}>
          You have used all your guesses for this round.
        </div>
      )}
    </div>
  )
}

/**
 * The header above the paper. It renders server frames only: no timer
 * authority, no locally invented word, and no scores the server did not send.
 * Scoreboards (v2 Phase 3) come from `state.scores` and `reveal.gains` via
 * roomsScores.js, which looks every name up in the server's player list.
 */
function GameHeader({
  game,
  ready,
  isHost,
  isDrawer,
  drawerName,
  playerCount,
  players,
  wordPick,
  yourWord,
  reveal,
  onStart,
  onPick,
}) {
  if (!ready || !game) return null

  if (game.phase === 'lobby') {
    return (
      <div className="game-header">
        {isHost ? (
          <button type="button" className="room-primary" disabled={playerCount < MIN_PLAYERS} onClick={onStart}>
            {playerCount < MIN_PLAYERS ? `Waiting for players (${playerCount}/${MIN_PLAYERS})` : 'Play'}
          </button>
        ) : (
          <span className="game-note">Waiting for the host to start…</span>
        )}
      </div>
    )
  }

  const roundLabel = `Round ${game.round} / ${game.rounds}`

  if (game.phase === 'pick') {
    const mine = isDrawer && wordPick && wordPick.round === game.round
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        {mine ? (
          <>
            <span className="game-note">Choose a word:</span>
            <div className="game-choices">
              {wordPick.options.map((word, i) => (
                <button key={word} type="button" className="game-choice" onClick={() => onPick(i)}>
                  {word}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="game-note">{drawerName} is choosing a word…</span>
        )}
      </div>
    )
  }

  if (game.phase === 'drawing') {
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        <Countdown game={game} />
        <span className="game-hint">{game.hint ?? ''}</span>
        {isDrawer ? (
          <span className="game-note">
            Your word: <strong>{yourWord && yourWord.round === game.round ? yourWord.word : '—'}</strong>
          </span>
        ) : (
          <span className="game-note">{drawerName} is drawing</span>
        )}
      </div>
    )
  }

  if (game.phase === 'reveal') {
    const sameRound = reveal && reveal.round === game.round
    const word = sameRound ? reveal.word : null
    const gains = sameRound ? gainRows(reveal, players) : null
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        <span className="game-word">{word ?? 'No one drew'}</span>
        {gains && gains.length > 0 && (
          <span className="game-gains" role="status">
            {gains.map((row) => (
              <span key={row.userId} className="game-gain">
                <span className="game-gain-name">{row.name}</span>
                <span className="game-gain-points">+{row.points}</span>
              </span>
            ))}
          </span>
        )}
      </div>
    )
  }

  if (game.phase === 'scores') {
    const count = game.correct.length
    const rows = standings(game, players)
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        <span className="game-note">{count > 0 ? `${count} guessed it` : 'No one guessed it'}</span>
        {rows && rows.length > 0 && <ScoreRows rows={rows} />}
      </div>
    )
  }

  if (game.phase === 'game_over') {
    const rows = standings(game, players)
    return (
      <div className="game-header game-header-card">
        <span className="game-note">Final scores</span>
        {rows && rows.length > 0 && <ScoreRows rows={rows} showFlags />}
        <span className="game-note">
          Back to lobby in <Countdown game={game} />
        </span>
      </div>
    )
  }

  return null
}

/**
 * A ranked scoreboard row set, from standings() in roomsScores.js: every
 * value came from the server's score map, every identity from the server's
 * player list. Display only — no arithmetic happens here.
 */
function ScoreRows({ rows, showFlags = false }) {
  return (
    <span className="game-scores">
      {rows.map((row) => (
        <span key={row.userId} className="game-score-row">
          <span className="game-score-rank">{row.rank}</span>
          <span className="game-score-name">{row.name}</span>
          {showFlags && row.country && (
            <span className="game-flag" aria-label={row.country}>
              {flagEmoji(row.country)}
            </span>
          )}
          <span className="game-score-total">{row.total}</span>
        </span>
      ))}
    </span>
  )
}

