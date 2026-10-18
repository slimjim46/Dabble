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

/** Hash of the request's client IP, or null when no salt is configured. */
export async function clientIpHash(request, env) {
  const salt = env.IP_HASH_SALT
  if (typeof salt !== 'string' || salt.length < 16) {
    logEvent('ip_salt_missing')
    return null
  }
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) return null
  return hashKey(salt, ip)
}
