import { roomsEntryHref } from '../lib/roomsEntry.js'
import { dailyEntryHref } from '../daily/dailyEntry.js'

const LABELS = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
}

export default function StatusPill({ status, online, saving, countries, ownerName, ownerUrl, privacyUrl }) {
  const connected = status === 'connected'
  const roomsHref = roomsEntryHref(import.meta.env)
  const dailyHref = dailyEntryHref(import.meta.env)
  const hasStats = typeof countries === 'number'
  const label = connected
    ? hasStats
      ? `${online} drawing · ${countries} ${countries === 1 ? 'country' : 'countries'}`
      : `${online} drawing`
    : LABELS[status] ?? 'Offline'
  const title = connected
    ? saving
      ? 'Live — your drawings are saved'
      : 'Live, but your drawings are not being saved (sign-in failed)'
    : 'Not connected to the shared canvas'

  return (
    <div className="status-bar">
      <div className="status-pill" role="status" title={title}>
        <span
          className={`status-dot ${connected ? 'status-dot-live' : 'status-dot-down'} ${
            connected && !saving ? 'status-dot-warn' : ''
          }`}
        />
        {label}
        {connected && !saving ? ' · not saving' : ''}
      </div>
      <div className="status-footer">
        {ownerName && ownerUrl ? (
          <span className="status-footer-item">
            made by <a href={ownerUrl} target="_blank" rel="noopener noreferrer">{ownerName}</a>
          </span>
        ) : ownerName ? (
          <span className="status-footer-item">made by {ownerName}</span>
        ) : null}
        {privacyUrl ? (
          <span className="status-footer-item">
            <a href={privacyUrl} target="_blank" rel="noopener noreferrer">about/privacy</a>
          </span>
        ) : null}
        {roomsHref ? (
          <span className="status-footer-item">
            <a href={roomsHref} className="status-footer-link" title="Draw together in a private room">Play with friends</a>
          </span>
        ) : null}
        {dailyHref ? (
          <span className="status-footer-item">
            <a href={dailyHref} className="status-footer-link" title="Today's daily drawing challenge">Daily challenge</a>
          </span>
        ) : null}
      </div>
    </div>
  )
}
