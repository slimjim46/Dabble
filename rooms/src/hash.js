// Keyed hashes: the raw IP never leaves this module, so nothing downstream
// can store or log one (AGENTS.md invariant 5).
//
// IP_HASH_SALT is a Wrangler secret. If it is missing the caller skips
// IP-keyed limits and logs a counted event — we never fall back to hashing
// with a guessable/empty salt.
import { logEvent } from './log.js'

let keyPromise = null

async function importKey(salt) {
  const enc = new TextEncoder()
  return crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * @returns 16 hex chars (64 bits) — enough to separate actors,
 * irreversible, and never equal to the input.
 */
export async function hashKey(salt, value) {
  if (typeof salt !== 'string' || salt.length < 16) return null
  if (typeof value !== 'string' || value.length === 0) return null
  if (!keyPromise) keyPromise = importKey(salt)
  const sig = await crypto.subtle.sign('HMAC', await keyPromise, new TextEncoder().encode(value))
  return [...new Uint8Array(sig)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Length-bounded charset for an IPv4/IPv6 literal (optionally with a zone).
const TEST_IP_RE = /^[0-9A-Fa-f:.%]{1,45}$/

/**
 * The IP used for per-IP limits. A dev-only test hook lets each test run use
 * a distinct bucket so the per-IP limits cannot leak between back-to-back
 * runs. It is honored ONLY when ENVIRONMENT is exactly 'dev': unset, 'Dev',
 * 'development', 'staging' and 'production' all ignore it. Anything that
 * could be a spoof vector in production never gets here.
 */
function resolveClientIp(request, env) {
  if (env.ENVIRONMENT === 'dev') {
    const testIp = request.headers.get('X-Test-IP')
    if (typeof testIp === 'string' && TEST_IP_RE.test(testIp)) return testIp
  }
  return request.headers.get('CF-Connecting-IP')
}

/** Hash of the request's client IP, or null when no salt is configured. */
export async function clientIpHash(request, env) {
  const salt = env.IP_HASH_SALT
  if (typeof salt !== 'string' || salt.length < 16) {
    logEvent('ip_salt_missing')
    return null
  }
  const ip = resolveClientIp(request, env)
  if (!ip) return null
  return hashKey(salt, ip)
}

/**
 * Production must have a usable salt or the per-IP caps are silently off;
 * the routes fail closed instead of serving unprotected. Dev stays lenient.
 */
export function ipHashSaltOk(env) {
  if (env.ENVIRONMENT !== 'production') return true
  return typeof env.IP_HASH_SALT === 'string' && env.IP_HASH_SALT.length >= 16
}
