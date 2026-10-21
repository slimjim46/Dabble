// Room codes: 5 chars from the no-look-alike alphabet. Format is validated
// in the Worker BEFORE any Durable Object is touched, so junk probes never
// reach the DO layer.
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN, ROOM_CODE_RE } from './config.js'

export function isValidCode(code) {
  return typeof code === 'string' && ROOM_CODE_RE.test(code)
}

export function randomCode() {
  const len = ROOM_CODE_ALPHABET.length
  const limit = Math.floor(256 / len) * len // rejection sampling: no modulo bias
  let out = ''
  while (out.length < ROOM_CODE_LEN) {
    const batch = new Uint8Array(64)
    crypto.getRandomValues(batch)
    for (const b of batch) {
      if (b >= limit) continue
      out += ROOM_CODE_ALPHABET[b % len]
      if (out.length === ROOM_CODE_LEN) break
    }
  }
  return out
}
