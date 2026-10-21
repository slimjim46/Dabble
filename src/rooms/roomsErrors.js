// Every reason the room screen can fail, in the visitor's words, plus which
// ones a Retry button can plausibly fix.
//
// Plain JS (not JSX) so tests/roomClient.test.mjs can import it and fail the
// moment roomsWire.js, roomsConfig.js or the transport grows an `error` value
// with no line here — a blank screen with a code in it is the failure mode.

export const ROOM_ERROR_COPY = {
  bad_code: 'That is not a valid room code.',
  auth: 'Could not sign you in. Try reloading the page.',
  kicked: 'You were removed from this room.',
  origin: 'This page is not allowed to join rooms.',
  banned: 'You cannot join rooms right now.',
  not_found: 'That room no longer exists.',
  too_many: 'Too many connections from this network.',
  rate_limited: 'Too many joins right now. Try again shortly.',
  busy: 'The rooms server is busy. Try again in a moment.',
  guess_cap: 'You have used all your guesses for this round.',
  unreachable: 'Cannot reach the rooms server.',
  full: 'That room is full.',
  join_failed: 'Could not join the room.',
  replaced: 'This room was opened in another tab.',
  expired: 'That room has expired.',
  too_big: 'The room closed the connection.',
  policy: 'The room closed the connection.',
  retry_exhausted: 'The connection keeps dropping. Try again later.',
}

/** Errors a Retry button can plausibly fix; everything else is a final screen. */
export const RETRYABLE_ERRORS = Object.freeze([
  'auth',
  'busy',
  'join_failed',
  'rate_limited',
  'retry_exhausted',
  'too_many',
  'unreachable',
])

/**
 * The `error` values only the transport can produce (not reachable by calling
 * roomsWire.js or roomsConfig.js directly from a test). Listed here so the
 * coverage check in tests/roomClient.test.mjs is complete rather than partial.
 */
export const TRANSPORT_ONLY_ERRORS = Object.freeze(['full'])

/**
 * Reasons the server may send in an `error` frame. Not connection errors: the
 * screen shows them as a transient notice beside `busy`. Listed so the copy
 * coverage check counts them as reachable.
 */
export const SERVER_NOTICE_ERRORS = Object.freeze(['busy', 'guess_cap'])
