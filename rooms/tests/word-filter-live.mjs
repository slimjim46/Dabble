// Live check of is_word_allowed against the DEV project (v2 Phase 4b): a real
// anonymous token (role authenticated) must be able to call the security-definer
// RPC through PostgREST, a clean word must be allowed, and the dev test term
// ('badword', from supabase/dev/phase6_dev_only.sql) must be blocked. Standalone
// (not *.test.mjs): run by hand.
//
//   ROOMS_ALLOWED_URL=https://dabble-rooms-dev-fast.rowan-dev-workers.workers.dev \
//     node tests/word-filter-live.mjs
import { anonUser, check, summary, SUPABASE_URL, ANON_KEY } from './helpers.mjs'
import { wordAllowed } from '../src/filter.js'

const { token } = await anonUser()
const env = { SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY }

check('live: a clean word is allowed', await wordAllowed('dog', token, env))
check('live: a two-letter word is rejected', !(await wordAllowed('ab', token, env)))
check('live: a non-token word (space) is rejected', !(await wordAllowed('has space', token, env)))
check('live: an uppercase word is rejected', !(await wordAllowed('DOG', token, env)))
check('live: an over-long word is rejected', !(await wordAllowed('a'.repeat(41), token, env)))
check('live: the dev test term is blocked', !(await wordAllowed('badword', token, env)))

summary('word-filter-live')
