// Verifies a Supabase access token against the project's published JWKS.
//
// The dev project signs access tokens asymmetrically (ES256): the public keys
// are served at /auth/v1/.well-known/jwks.json and jose fetches/caches them.
// No shared secret is needed, so there is no secret to hold here.
//
// A missing, malformed, wrong-issuer/audience, or expired token returns null.
// Anonymous (guest) tokens are valid: they carry is_anonymous = true but still
// have role/audience "authenticated".
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Keyed by project URL; one cached JWKS per isolate. createRemoteJWKSet does
// its own caching and re-fetching, so this only avoids building a new fetcher.
const jwksByUrl = new Map()

function jwksFor(supabaseUrl) {
  let set = jwksByUrl.get(supabaseUrl)
  if (!set) {
    set = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    jwksByUrl.set(supabaseUrl, set)
  }
  return set
}

/**
 * @returns the token claims, or null when the token is not acceptable.
 */
export async function verifyAccessToken(token, env) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null
  const issuer = `${env.SUPABASE_URL}/auth/v1`
  try {
    const { payload } = await jwtVerify(token, jwksFor(env.SUPABASE_URL), {
      issuer,
      audience: 'authenticated',
      // jose rejects expired tokens by default (exp is checked).
    })
    return payload
  } catch {
    return null
  }
}
