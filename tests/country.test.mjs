// Unit tests for src/lib/country.js (Phase 7): the flag + playtime helpers used
// by the cursor overlay and the country leaderboard. Plain node:
//   node tests/country.test.mjs
import { flagEmoji, formatPlaytime } from '../src/lib/country.js'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// flagEmoji ------------------------------------------------------------------
check('flagEmoji maps a two-letter code to regional indicators',
  flagEmoji('DE') === '🇩🇪', JSON.stringify(flagEmoji('DE')))
check('flagEmoji handles another country', flagEmoji('BR') === '🇧🇷', JSON.stringify(flagEmoji('BR')))
check('flagEmoji is empty for a missing country',
  flagEmoji(undefined) === '' && flagEmoji(null) === '')
check('flagEmoji is empty for malformed input',
  flagEmoji('D') === '' && flagEmoji('de') === '' && flagEmoji('1A') === '' && flagEmoji('DEU') === '')

// formatPlaytime -------------------------------------------------------------
check('formatPlaytime rounds tiny values to minutes',
  formatPlaytime(90) === '2m', formatPlaytime(90))
check('formatPlaytime shows hours under a day',
  formatPlaytime(5400) === '2h', formatPlaytime(5400))
check('formatPlaytime shows days beyond 24h',
  formatPlaytime(259200) === '3d', formatPlaytime(259200))
check('formatPlaytime is 0m for zero / junk',
  formatPlaytime(0) === '0m' && formatPlaytime(-5) === '0m' &&
  formatPlaytime(null) === '0m' && formatPlaytime(NaN) === '0m')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
