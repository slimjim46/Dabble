// Session tracking for this tab (Phase 4.2).
//
// The server (/api/session, /api/heartbeat) is the source of truth; this module
// only remembers the ids in memory for the lifetime of the tab. Every call is
// best-effort: plain `vite` does not serve /api, so a 404 or a network error
// must leave the canvas exactly as it was.
const state = { sessionId: null, country: null }

let client = null

export function getSession() {
  return state
}

async function accessToken() {
  if (!client) return null
  try {
    const { data } = await client.auth.getSession()
    return data?.session?.access_token ?? null
  } catch {
    return null
  }
}

async function post(path, body, token) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** Called once after anonymous sign-in. Returns null when /api is absent. */
export async function startSession(supabaseClient) {
  client = supabaseClient
  try {
    const token = await accessToken()
    if (!token) return null
    const data = await post('/api/session', {}, token)
    if (typeof data?.session_id === 'string') state.sessionId = data.session_id
    state.country = typeof data?.country === 'string' ? data.country : null
    return { ...state }
  } catch {
    return null
  }
}

/** 30-second heartbeat; the server decides whether the write is needed. */
export async function sendHeartbeat() {
  try {
    const token = await accessToken()
    if (!token || !state.sessionId) return null
    const data = await post('/api/heartbeat', { session_id: state.sessionId }, token)
    if (typeof data?.session_id === 'string') state.sessionId = data.session_id
    return { ...state }
  } catch {
    return null
  }
}

/** pagehide: sendBeacon cannot set headers, so the token goes in the body. */
export function beaconHeartbeat() {
  try {
    const tokenPromise = accessToken()
    Promise.resolve(tokenPromise).then((token) => {
      if (!token || !state.sessionId) return
      const body = JSON.stringify({ session_id: state.sessionId, access_token: token })
      navigator.sendBeacon('/api/heartbeat', new Blob([body], { type: 'application/json' }))
    })
  } catch {
    // best effort only
  }
}
