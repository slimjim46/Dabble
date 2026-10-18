// Header allowlist for the Worker -> Room DO join request.
//
// The forwarded request is built from scratch instead of copying the
// client's headers: only WebSocket handshake headers are copied across,
// and every X-* field is Worker-set or absent. Client-forged X-Action
// (create with no Turnstile and no hourly limits), X-IP-Hash (per-IP cap
// bypass), X-User / X-User-Name / X-User-Country / X-Protocol can never
// cross this line, and Sec-WebSocket-Protocol (the JWT carrier) is never
// forwarded.
import { MAX_NAME_LENGTH } from './config.js'

const HANDSHAKE_HEADERS = ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Extensions']

/**
 * @param srcHeaders the client's request headers (untrusted)
 * @param trusted Worker-computed identity: { userId, name, country, ipHash }
 * @returns Headers for the DO join request
 */
export function buildJoinHeaders(srcHeaders, trusted) {
  const headers = new Headers()
  for (const name of HANDSHAKE_HEADERS) {
    const value = srcHeaders.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('X-Protocol', 'dabble.v1')
  headers.set('X-User', trusted.userId)
  headers.set('X-User-Name', encodeURIComponent(trusted.name.slice(0, MAX_NAME_LENGTH)))
  headers.set('X-User-Country', trusted.country || '')
  if (trusted.ipHash) headers.set('X-IP-Hash', trusted.ipHash)
  return headers
}
