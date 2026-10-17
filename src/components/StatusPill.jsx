const LABELS = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
}

export default function StatusPill({ status, online, saving, countries }) {
  const connected = status === 'connected'
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
    <div className="status-pill" role="status" title={title}>
      <span
        className={`status-dot ${connected ? 'status-dot-live' : 'status-dot-down'} ${
          connected && !saving ? 'status-dot-warn' : ''
        }`}
      />
      {label}
      {connected && !saving ? ' · not saving' : ''}
    </div>
  )
}
