// Logging: event names and counts only. Never tokens, IPs, raw addresses,
// user names, room codes/words, or free-form user data.
//
// logEvent('join', { n: 1, host: true }) -> {"e":"join","n":1,"host":true}
// Field values must be numbers, booleans, or short enum-ish strings
// (lowercase, digits, underscore). Anything else is replaced with null so a
// careless call cannot leak a user string into the logs.
const SAFE_VALUE = /^[a-z0-9_]{1,32}$/

function safe(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && SAFE_VALUE.test(value)) return value
  return null
}

export function logEvent(name, fields = {}) {
  if (!SAFE_VALUE.test(name)) return
  const out = { e: name }
  for (const [k, v] of Object.entries(fields)) {
    if (SAFE_VALUE.test(k)) out[k] = safe(v)
  }
  console.log(JSON.stringify(out))
}
