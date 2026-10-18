// Cloudflare Turnstile verification for POST /rooms. Active only when
// TURNSTILE_SECRET is set; without a secret the check is skipped (owner
// enables it later by adding the Wrangler secret).
//
// Fail closed when enabled: a missing token, a rejected token, or an
// unreachable/misbehaving siteverify endpoint all return false. Tests mock
// the fetch function.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstile(token, secret, fetchImpl = fetch) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return false
  if (typeof secret !== 'string' || secret.length === 0) return false
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data?.success === true
  } catch {
    return false
  }
}
