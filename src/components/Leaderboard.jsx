import { useState } from 'react'
import { flagEmoji, formatPlaytime } from '../lib/country.js'
import { useCountryLeaderboard } from '../hooks/useCountryLeaderboard.js'

const WINDOWS = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: 'all', label: 'All' },
]

/**
 * Small collapsible country board. Country level only — the RPC is aggregate
 * and never returns individual users. Everything load-related lives in the
 * hook, which only polls while this is open and the tab is visible.
 */
export default function Leaderboard({ country }) {
  const [open, setOpen] = useState(false)
  const [windowKey, setWindowKey] = useState('24h')
  const { rows, failed } = useCountryLeaderboard({ expanded: open, window: windowKey })

  return (
    <div className={`leaderboard ${open ? 'leaderboard-open' : ''}`}>
      <button
        type="button"
        className="leaderboard-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Top countries"
      >
        <span aria-hidden="true">🌍</span>
        <span className="leaderboard-toggle-label">Top countries</span>
        <span className="leaderboard-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="leaderboard-card">
          <div className="leaderboard-windows" role="tablist" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="tab"
                aria-selected={windowKey === w.key}
                className={`leaderboard-window ${windowKey === w.key ? 'leaderboard-window-active' : ''}`}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>

          {failed ? (
            <div className="leaderboard-empty">Couldn’t load the board</div>
          ) : rows === null ? (
            <div className="leaderboard-empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="leaderboard-empty">No one yet</div>
          ) : (
            <>
              <ol className="leaderboard-list">
                {rows.map((row) => (
                  <li
                    key={row.code}
                    className={`leaderboard-row ${row.code === country ? 'leaderboard-me' : ''}`}
                  >
                    <span className="leaderboard-flag" aria-hidden="true">
                      {flagEmoji(row.code) || '🏳️'}
                    </span>
                    <span className="leaderboard-code">{row.code}</span>
                    <span className="leaderboard-metrics" title={`${row.players} players · ${row.strokes} strokes`}>
                      {row.players} · {row.strokes} · {formatPlaytime(row.playtime_seconds)}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="leaderboard-legend">players · strokes · time</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
