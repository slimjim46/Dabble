/**
 * Country-code helpers shared by the cursor overlay and the leaderboard.
 * Everything here is pure so it can be unit-tested without a DOM.
 */

/** "DE" -> 🇩🇪 (regional indicator pair). Unknown codes return ''. */
export function flagEmoji(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** Compact playtime for the leaderboard: 90 -> "1m", 5400 -> "2h", 3 days -> "3d". */
export function formatPlaytime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '0m'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}
