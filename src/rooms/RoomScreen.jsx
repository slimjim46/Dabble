import { useEffect, useMemo, useRef, useState } from 'react'
import { createCursorStore } from '../engine/cursorStore.js'
import { createStrokeStore } from '../engine/strokeStore.js'
import { loadIdentity } from '../lib/identity.js'
import { copyText } from './roomsClipboard.js'
import { RETRYABLE_ERRORS, ROOM_ERROR_COPY } from './roomsErrors.js'
import { MIN_PLAYERS } from './roomsConfig.js'
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

  const { api, status, ready, error, players, seat, isHost, kickNotice, game, wordPick, yourWord, reveal } =
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

      <GameHeader
        game={game}
        ready={ready}
        isHost={isHost}
        isDrawer={isDrawer}
        drawerName={drawerName}
        playerCount={players.length}
        wordPick={wordPick}
        yourWord={yourWord}
        reveal={reveal}
        onStart={() => api.start()}
        onPick={(i) => api.pick(i)}
      />

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
              return (
                <li key={player.userId} className="room-player">
                  <span className="room-player-name" title={player.country ?? undefined}>
                    {player.name}
                    {mine ? ' (you)' : ''}
                  </span>
                  {player.host && <span className="room-host-badge">host</span>}
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


      {status === 'reconnecting' && !isError && (
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
 * The header above the paper. It is a pure renderer of server frames: no
 * timer authority, no local guessing of the word, and no scores invented in
 * step 3. `reveal`/`scores` show what the server sent and say the numbers
 * arrive later.
 */
function GameHeader({
  game,
  ready,
  isHost,
  isDrawer,
  drawerName,
  playerCount,
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
    const word = reveal && reveal.round === game.round ? reveal.word : null
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        <span className="game-word">{word ?? 'No one drew'}</span>
        <span className="game-note">Scores arrive in a later update</span>
      </div>
    )
  }

  if (game.phase === 'scores') {
    const count = game.correct.length
    return (
      <div className="game-header game-header-card">
        <span className="game-round">{roundLabel}</span>
        <span className="game-note">{count > 0 ? `${count} guessed it` : 'No one guessed it'}</span>
        <span className="game-note">Scores arrive in a later update</span>
      </div>
    )
  }

  if (game.phase === 'game_over') {
    return (
      <div className="game-header game-header-card">
        <span className="game-note">Returning to lobby…</span>
        <Countdown game={game} />
      </div>
    )
  }

  return null
}

