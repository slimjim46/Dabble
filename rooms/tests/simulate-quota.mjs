// Dev-only end-to-end proof of the daily-quota busy path.
//
//   1. Deploy the dev worker with the knob:   npx wrangler deploy --var SIMULATE_QUOTA:1
//   2. ROOMS_ALLOWED_URL=... node tests/simulate-quota.mjs
//      -> every authenticated create/join must answer 503 rooms_busy + Retry-After: 30
//   3. Redeploy WITHOUT the knob, then prove dev is normal again:
//      ROOMS_ALLOWED_URL=... node tests/simulate-quota.mjs expect-normal
//      -> create answers 201
//
// The knob only works when ENVIRONMENT=dev; busy-unit.test.mjs proves the
// ENVIRONMENT!=='dev' branch offline.
import { anonUser, check, createRoom, probeWs, summary } from './helpers.mjs'
import { randomCode } from '../src/codes.js'

const mode = process.argv[2] === 'expect-normal' ? 'normal' : 'busy'

const { token } = await anonUser()

if (mode === 'busy') {
  // Probe with a join against a code that does not exist: with the knob on
  // this must short-circuit to 503 BEFORE any DO is touched (no room made).
  const code = randomCode()
  const probe = await probeWs(code, ['dabble.v1', token])
  check('join (nonexistent room): 503 rooms_busy, not 404', probe.status === 503, `status ${probe.status}`)
  check('join: Retry-After 30', probe.headers?.get?.('retry-after') === '30', String(probe.headers?.get?.('retry-after')))

  const created = await createRoom(token)
  check('create: 503 rooms_busy', created.status === 503 && created.body?.error === 'rooms_busy', `status ${created.status} body ${JSON.stringify(created.body)}`)
  check('create: Retry-After 30', created.headers.get('retry-after') === '30', String(created.headers.get('retry-after')))
} else {
  const created = await createRoom(token)
  check('create: 201 after knob removed', created.status === 201, `status ${created.status}`)
  check('create: a code came back', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(created.body?.code || ''), JSON.stringify(created.body))
}

summary(`simulate-quota (${mode})`)
