// Server-anchored timer maths for the daily challenge. Pure functions so
// tests/dailyClient.test.mjs can prove a skewed client clock cannot cheat.

/**
 * The client-clock offset from a start request, taken at the request midpoint
 * so the error is bounded by half the round-trip time. `serverNowMs` is the
 * server's own clock (start_daily_attempt's server_now), `sentMs`/`receivedMs`
 * are the client's monotonic wall-clock around the request.
 */
export function computeOffset(serverNowMs, sentMs, receivedMs) {
  const mid = (sentMs + receivedMs) / 2
  return { offset: serverNowMs - mid, marginMs: (receivedMs - sentMs) / 2 }
}

/** Server time for a given client time, using a known offset. */
export function toServerTime(clientNowMs, offset) {
  return clientNowMs + offset
}

/** Milliseconds left in the attempt (countdown + auto-submit use this, not grace). */
export function attemptRemainingMs(startedAtMs, serverNowMs, attemptSeconds) {
  return startedAtMs + attemptSeconds * 1000 - serverNowMs
}

/** The hard deadline for a retrying submit: attempt + grace. */
export function retryDeadlineMs(startedAtMs, attemptSeconds, graceSeconds) {
  return startedAtMs + (attemptSeconds + graceSeconds) * 1000
}

/** Milliseconds until the next UTC midnight (for "new prompt in Xh Ym"). */
export function msToNextUtcMidnight(nowMs) {
  const d = new Date(nowMs)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return next - nowMs
}

/** "Xh Ym" label for a duration in ms. */
export function humanCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${h}h ${m}m`
}
