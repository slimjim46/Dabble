// Test runner: runs every tests/*.test.mjs in order, stops at the first
// failure. Suites are standalone too (node tests/auth.test.mjs).
//
//   npm test
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort((a, b) => {
    // pure unit tests first, then live suites alphabetically
    const rank = (f) => (f.startsWith('auth-unit') ? 0 : 1)
    return rank(a) - rank(b) || a.localeCompare(b)
  })

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.error(`--- ${suite} FAILED (exit ${r.status})`)
    break
  }
}

if (failed > 0) process.exit(1)
console.log('\nAll suites passed.')
