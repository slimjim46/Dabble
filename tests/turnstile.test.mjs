// Unit tests for src/lib/turnstile.js (Phase 7): the captcha wait must be
// bounded on every path — a challenge that never answers has to resolve to
// null rather than block anonymous sign-in forever. No network, no real
// widget: the script loader and the token wait take their DOM/API objects as
// arguments precisely so this can be tested in plain node.
//   node tests/turnstile.test.mjs
import {
  ensureCaptchaToken,
  loadTurnstileScript,
  resetTurnstile,
  waitForToken,
} from '../src/lib/turnstile.js'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A script/element stub whose load and error events we fire by hand. */
function fakeScript() {
  const listeners = {}
  return {
    parentNode: null,
    addEventListener(type, fn) {
      ;(listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn)
    },
    fire(type) {
      for (const fn of [...(listeners[type] || [])]) fn()
    },
    listenerCount(type) {
      return (listeners[type] || []).length
    },
  }
}

function fakeDom() {
  const created = []
  const nodes = []
  const doc = {
    createElement() {
      const el = fakeScript()
      created.push(el)
      return el
    },
    head: {
      appendChild(el) {
        el.parentNode = this
      },
      removeChild(el) {
        el.parentNode = null
      },
    },
    body: {
      appendChild(el) {
        el.parentNode = this
        nodes.push(el)
      },
      removeChild(el) {
        el.parentNode = null
        const at = nodes.indexOf(el)
        if (at >= 0) nodes.splice(at, 1)
      },
    },
  }
  return { doc, created }
}

// ---- waitForToken: the token wait itself ------------------------------------

{
  let captured = null
  const turnstile = {
    render(el, options) {
      captured = options
      setTimeout(() => options.callback('token-abc'), 0)
      return 'widget-1'
    },
  }
  const token = await waitForToken(turnstile, {}, { siteKey: 'sitekey', timeoutMs: 500 })
  check('resolves the token the widget reports', token === 'token-abc', String(token))
  check('renders with the site key', captured && captured.sitekey === 'sitekey', JSON.stringify(captured))
  check('renders invisibly (widget is created Invisible in the dashboard)',
    captured && captured.size === 'invisible', `size=${captured?.size}`)
  check('passes a callback for the token', captured && typeof captured.callback === 'function')
  check('passes an error callback', captured && typeof captured['error-callback'] === 'function')
  check('passes an expiry callback', captured && typeof captured['expired-callback'] === 'function')
}

{
  const errorFirst = {
    render(el, options) {
      setTimeout(() => options['error-callback'](), 0)
      return 'w'
    },
  }
  const token = await waitForToken(errorFirst, {}, { siteKey: 'k', timeoutMs: 500 })
  check('resolves null when the challenge reports an error', token === null, String(token))
}

{
  const expiresFirst = {
    render(el, options) {
      setTimeout(() => options['expired-callback'](), 0)
      return 'w'
    },
  }
  const token = await waitForToken(expiresFirst, {}, { siteKey: 'k', timeoutMs: 500 })
  check('resolves null when the token expires before it is used', token === null, String(token))
}

{
  const silent = { render: () => 'w' } // never calls back
  const started = Date.now()
  const token = await waitForToken(silent, {}, { siteKey: 'k', timeoutMs: 25 })
  const elapsed = Date.now() - started
  check('resolves null when nothing answers', token === null, String(token))
  check('gives up within the requested timeout', elapsed >= 20 && elapsed < 1500, `${elapsed} ms`)
}

{
  const boom = {
    render() {
      throw new Error('widget api missing')
    },
  }
  const token = await waitForToken(boom, {}, { siteKey: 'k', timeoutMs: 25 })
  check('resolves null when render() throws', token === null, String(token))
}

{
  const solved = {
    render: () => 'w1',
    getResponse: () => 'already-solved',
  }
  const token = await waitForToken(solved, {}, { siteKey: 'k', timeoutMs: 500 })
  check('takes a token the widget already holds', token === 'already-solved', String(token))
}

{
  const empty = {
    render(el, options) {
      setTimeout(() => options.callback(''), 0)
      return 'w'
    },
  }
  const token = await waitForToken(empty, {}, { siteKey: 'k', timeoutMs: 500 })
  check('treats an empty token as no token', token === null, String(token))
}

{
  const notAString = {
    render(el, options) {
      setTimeout(() => options.callback({ nope: true }), 0)
      return 'w'
    },
  }
  const token = await waitForToken(notAString, {}, { siteKey: 'k', timeoutMs: 500 })
  check('treats a non-string token as no token', token === null, String(token))
}

// ---- loadTurnstileScript: bounded, cached, never throws ---------------------

{
  const win = { turnstile: { render: () => 'w' } }
  const { doc, created } = fakeDom()
  const loaded = await loadTurnstileScript(doc, win, { timeoutMs: 25 })
  check('returns the existing widget API without loading anything',
    loaded === win.turnstile && created.length === 0, `${created.length} script(s)`)
}

{
  const win = {}
  const { doc, created } = fakeDom()
  const pending = loadTurnstileScript(doc, win, { timeoutMs: 25 })
  check('appends exactly one script tag', created.length === 1, `${created.length}`)
  const loaded = await pending
  check('resolves null when the script never loads', loaded === null, String(loaded))
  check('removes the dead script tag', created[0].parentNode === null)
}

{
  const win = {}
  const { doc, created } = fakeDom()
  const pending = loadTurnstileScript(doc, win, { timeoutMs: 500 })
  created[0].fire('error')
  const loaded = await pending
  check('resolves null when the script errors', loaded === null, String(loaded))
  check('drops its listeners when the script errors', created[0].listenerCount('load') === 0)
}

{
  const win = {}
  const { doc, created } = fakeDom()
  const pending = loadTurnstileScript(doc, win, { timeoutMs: 500 })
  win.turnstile = { render: () => 'w' } // the script did its job
  created[0].fire('load')
  const loaded = await pending
  check('resolves the widget API after a successful load',
    loaded === win.turnstile, JSON.stringify(loaded))
}

{
  const loaded = await loadTurnstileScript(null, null, { timeoutMs: 10 })
  check('resolves null without a document or window', loaded === null, String(loaded))
}

// ---- ensureCaptchaToken: the path anonymous sign-in actually takes ----------

{
  const token = await ensureCaptchaToken('', { doc: fakeDom().doc, win: {}, timeoutMs: 10 })
  check('skips everything when no site key is set', token === null, String(token))
}

{
  resetTurnstile()
  const { doc, created } = fakeDom()
  const win = {} // no widget API ever arrives
  const first = await ensureCaptchaToken('site-key', { doc, win, timeoutMs: 25 })
  check('fails fast with null when the challenge cannot run', first === null, String(first))
  const afterFirst = created.length

  const second = await ensureCaptchaToken('site-key', { doc, win, timeoutMs: 25 })
  const started = Date.now()
  const third = await ensureCaptchaToken('site-key', { doc, win, timeoutMs: 25 })
  check('does not re-run the challenge while backing off',
    second === null && third === null && created.length === afterFirst,
    `${created.length} script(s), expected ${afterFirst}`)
  check('backoff replies immediately instead of waiting again',
    Date.now() - started < 20, `${Date.now() - started} ms`)
  resetTurnstile()
}

{
  resetTurnstile()
  const { doc } = fakeDom()
  const started = Date.now()
  const token = await ensureCaptchaToken('site-key', { doc, win: {}, timeoutMs: 30 })
  const elapsed = Date.now() - started
  check('the whole token wait stays bounded', token === null && elapsed >= 25 && elapsed < 1500, `${elapsed} ms`)
  resetTurnstile()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
