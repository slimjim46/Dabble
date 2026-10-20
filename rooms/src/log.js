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

// Diagnostics-only logger (ALARM_DIAG, dev). Same event-name safety, but
// numeric fields pass through unchanged even when large (epoch ms, deltas)
// and string fields are truncated rather than dropped to null — a stack's
// first line is still an event name, count, or class, never user data.
// Never call this with tokens, IPs, names, room words, or free-form input.
const MAX_DIAG_STRING = 200

function diagValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length > MAX_DIAG_STRING ? v.slice(0, MAX_DIAG_STRING) : v
  return null
}

export function logDiag(name, fields = {}) {
  if (!SAFE_VALUE.test(name)) return
  const out = { e: name, diag: true }
  for (const [k, v] of Object.entries(fields)) {
    if (SAFE_VALUE.test(k)) out[k] = diagValue(v)
  }
  console.log(JSON.stringify(out))
}
