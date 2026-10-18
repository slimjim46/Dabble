// Cloudflare Turnstile for anonymous sign-in (Phase 7f).
//
// The script is loaded from src code, and only when the deployment sets
// VITE_TURNSTILE_SITE_KEY: index.html carries no third-party script, so a site
// without a key never talks to challenges.cloudflare.com at all.
//
// Every wait here is bounded. A challenge that never answers resolves to null,
// and the caller then fails the sign-in visibly ("not saving") instead of
// hanging the canvas on a request that can never finish.
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
export const TURNSTILE_TIMEOUT_MS = 8000

// A failed challenge is not fixed by retrying two seconds later, and every
// retry would otherwise re-run the full wait: fail fast for a while instead.
const CAPTCHA_BACKOFF_MS = 30000

let scriptPromise = null
let backoffUntil = 0

/** Test hook: forget the cached script promise and the backoff window. */
export function resetTurnstile() {
  scriptPromise = null
  backoffUntil = 0
}

/**
 * Load the Turnstile script once. Resolves with `window.turnstile`, or null if
 * the load errors, or nothing answers within `timeoutMs`.
 */
export function loadTurnstileScript(doc, win, { src = TURNSTILE_SCRIPT_URL, timeoutMs = TURNSTILE_TIMEOUT_MS } = {}) {
  if (!doc || !win) return Promise.resolve(null)
  if (win.turnstile) return Promise.resolve(win.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve) => {
    const el = doc.createElement('script')
    let timer = null
    let settled = false
    const finish = (loaded) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      el.removeEventListener('load', onLoad)
      el.removeEventListener('error', onError)
      if (!loaded && el.parentNode) el.parentNode.removeChild(el)
      resolve(loaded && win.turnstile ? win.turnstile : null)
    }
    const onLoad = () => finish(true)
    const onError = () => finish(false)
    timer = setTimeout(() => finish(false), timeoutMs)
    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)
    el.async = true
    el.src = src
    ;(doc.head || doc.body).appendChild(el)
  }).then((value) => {
    // Drop the cache: a success short-circuits on win.turnstile, a failure
    // must stay retryable once the backoff window has passed.
    scriptPromise = null
    return value
  })

  return scriptPromise
}

/**
 * Ask one rendered widget for a token. Resolves with the token, or null when
 * the challenge reports an error, expires, times out, or the widget API
 * misbehaves. This is the piece the sign-in path waits on, so it can never
 * leave a caller hanging.
 *
 * @param {{render:Function,getResponse?:Function}} turnstile
 * @param {*} container element the widget renders into
 * @param {{siteKey:string,timeoutMs?:number,schedule?:Function,cancel?:Function}} opts
 */
export function waitForToken(
  turnstile,
  container,
  { siteKey, timeoutMs = TURNSTILE_TIMEOUT_MS, schedule = setTimeout, cancel = clearTimeout } = {},
) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (token) => {
      if (settled) return
      settled = true
      if (timer !== null) cancel(timer)
      resolve(typeof token === 'string' && token.length > 0 ? token : null)
    }
    // Only a non-empty string counts: the server treats anything else as no
    // captcha at all, so we must not pass it on as if it were a token.
    timer = schedule(() => finish(null), timeoutMs)

    let widgetId
    try {
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: finish,
        'error-callback': () => finish(null),
        'expired-callback': () => finish(null),
      })
    } catch {
      finish(null)
      return
    }

    // A widget that is already solved answers straight away.
    try {
      const existing = typeof turnstile.getResponse === 'function' ? turnstile.getResponse(widgetId) : ''
      if (existing) finish(existing)
    } catch {
      finish(null)
    }
  })
}

/**
 * Full path used by anonymous sign-in: load the script (only if a site key is
 * configured), render a hidden widget, wait for one token. Never throws and
 * never blocks for longer than the bounded waits above.
 *
 * @param {string|undefined|null} siteKey VITE_TURNSTILE_SITE_KEY
 */
export async function ensureCaptchaToken(siteKey, { doc, win, timeoutMs = TURNSTILE_TIMEOUT_MS } = {}) {
  if (!siteKey) return null
  const w = win ?? (typeof window !== 'undefined' ? window : null)
  const d = doc ?? (w ? w.document : null)
  if (!w || !d || !d.body) return null
  if (Date.now() < backoffUntil) return null

  const giveUp = () => {
    backoffUntil = Date.now() + CAPTCHA_BACKOFF_MS
    return null
  }

  try {
    const turnstile = await loadTurnstileScript(d, w, { timeoutMs })
    if (!turnstile) {
      console.warn('[dabble] turnstile script unavailable — captcha skipped for a moment')
      return giveUp()
    }

    const container = d.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;overflow:hidden'
    d.body.appendChild(container)
    try {
      const token = await waitForToken(turnstile, container, { siteKey, timeoutMs })
      if (!token) {
        console.warn('[dabble] captcha challenge did not yield a token')
        return giveUp()
      }
      return token
    } finally {
      if (typeof container.remove === 'function') container.remove()
      else if (container.parentNode) container.parentNode.removeChild(container)
    }
  } catch {
    console.warn('[dabble] captcha setup failed')
    return giveUp()
  }
}
