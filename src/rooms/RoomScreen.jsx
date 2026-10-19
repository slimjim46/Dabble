import { useEffect, useMemo, useRef, useState } from 'react'
import { createCursorStore } from '../engine/cursorStore.js'
import { createStrokeStore } from '../engine/strokeStore.js'
import { loadIdentity } from '../lib/identity.js'
import { copyText } from './roomsClipboard.js'
import { RETRYABLE_ERRORS, ROOM_ERROR_COPY } from './roomsErrors.js'
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

  const { api, status, ready, error, players, seat, isHost, kickNotice } = useRoomTransport({
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
        disabled={!ready}
        redrawRef={redrawRef}
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
