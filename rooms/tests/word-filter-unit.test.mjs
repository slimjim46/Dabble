// Unit tests for the custom-word filter (v2 Phase 4b): wordAllowed() fails
// closed and calls is_word_allowed with the player's own JWT. No network —
// the global fetch is stubbed. A word is never logged here.
//
//   node tests/word-filter-unit.test.mjs
import { wordAllowed } from '../src/filter.js'
import { check, summary } from './helpers.mjs'

const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon-key' }
const jwt = 'jwt-token'

let lastCall = null
function stubFetch(impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = original }
}

const respond = (ok, body) => ({ ok, json: async () => body })
const record = (ok, body) => async (url, init) => { lastCall = { url, init }; return respond(ok, body) }

// true / false passthrough.
let restore = stubFetch(record(true, true))
check('filter: a true body is allowed', await wordAllowed('dog', jwt, env))
restore()
restore = stubFetch(record(true, false))
check('filter: a false body is rejected', !(await wordAllowed('dog', jwt, env)))
restore()

// The RPC is called with the user JWT (not a service key) and the word.
restore = stubFetch(record(true, true))
await wordAllowed('dog', jwt, env)
const ok = lastCall.url === 'https://test.supabase.co/rest/v1/rpc/is_word_allowed' &&
  lastCall.init.headers.Authorization === 'Bearer jwt-token' &&
  lastCall.init.headers.apikey === 'anon-key' &&
  JSON.parse(lastCall.init.body).p_word === 'dog'
check('filter: posts to is_word_allowed with the bearer token and the word', ok, JSON.stringify(lastCall))
restore()

// Fail closed on every failure mode: HTTP error, network error, a non-boolean
// body, and a missing anon key.
restore = stubFetch(record(false, true))
check('filter: a non-200 fails closed', !(await wordAllowed('dog', jwt, env)))
restore()
restore = stubFetch(async () => { throw new Error('network down') })
check('filter: a network error fails closed', !(await wordAllowed('dog', jwt, env)))
restore()
restore = stubFetch(async () => { throw new DOMException('aborted', 'AbortError') })
check('filter: an abort/timeout fails closed', !(await wordAllowed('dog', jwt, env)))
restore()
restore = stubFetch(record(true, 'yes'))
check('filter: a non-boolean body is not allowed', !(await wordAllowed('dog', jwt, env)))
restore()
check('filter: a missing anon key fails closed',
  !(await wordAllowed('dog', jwt, { SUPABASE_URL: env.SUPABASE_URL })))

summary('word-filter-unit')
