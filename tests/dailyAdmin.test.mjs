// v2 Phase 5c-1: admin daily entry review tests.
// Runs against DEV. Negative paths always run; positive path requires
// DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD env vars (create the user in the
// Supabase dashboard first, then set the env vars). Admin is revoked in a
// finally block.
//
// Run:
//   set -a && source <dev env> && set +a
//   DEV_ADMIN_EMAIL=... DEV_ADMIN_PASSWORD=... node tests/dailyAdmin.test.mjs
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and VITE_SUPABASE_ANON_KEY (dev project) first.')
  process.exit(1)
}

let pass = 0
let fail = 0
function check(n, label, ok, extra) {
  if (ok) { pass++; console.log(`  ok   ${n}  ${label}`) }
  else { fail++; console.log(`  FAIL ${n}  ${label}${extra ? ` — ${extra}` : ''}`) }
}
const code = (e) => String(e?.code ?? '')

const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const uuid = () => crypto.randomUUID()

const ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD

// ---- negative paths (always run) ------------------------------------------
{
  const A = await (async () => {
    const c = client()
    const { data } = await c.auth.signInAnonymously()
    return { c, id: data.user.id }
  })()
  const noAuth = client()

  // admin_list_daily_entries
  const listAnon = await noAuth.rpc('admin_list_daily_entries', { p_limit: 5 })
  const listNonAdmin = await A.c.rpc('admin_list_daily_entries', { p_limit: 5 })
  check('neg-list', 'admin_list_daily_entries: anon and non-admin rejected (42501)',
    (listAnon.error && code(listAnon.error) === '42501') &&
    (listNonAdmin.error && code(listNonAdmin.error) === '42501'),
    `anon=${code(listAnon.error)} nonadmin=${code(listNonAdmin.error)}`)

  // admin_review_daily_entry
  const reviewAnon = await noAuth.rpc('admin_review_daily_entry', { p_entry_id: uuid(), p_approve: true })
  const reviewNonAdmin = await A.c.rpc('admin_review_daily_entry', { p_entry_id: uuid(), p_approve: true })
  check('neg-review', 'admin_review_daily_entry: anon and non-admin rejected (42501)',
    (reviewAnon.error && code(reviewAnon.error) === '42501') &&
    (reviewNonAdmin.error && code(reviewNonAdmin.error) === '42501'),
    `anon=${code(reviewAnon.error)} nonadmin=${code(reviewNonAdmin.error)}`)

  // null p_approve
  // (need an admin for this, but non-admin gets 42501 first; test null with a
  //  real admin in the positive path below)
}

// ---- positive path (requires DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD) ----------
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.log('\n  SKIP positive admin path: set DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD')
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

const adminClient = client()
const { data: signInData, error: signInErr } = await adminClient.auth.signInWithPassword({
  email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
})
if (signInErr) {
  console.error(`Admin sign-in failed: ${signInErr.message}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(1)
}
const adminId = signInData.user.id
console.log(`Admin user: ${adminId}`)

// Promote to admin
await adminClient.rpc('dev_only_set_admin', { p_enabled: true })
const { data: refreshed } = await adminClient.auth.refreshSession()
const isAdmin = refreshed?.user?.app_metadata?.role === 'admin'
check('admin-promote', 'dev_only_set_admin promotes the non-anonymous caller',
  isAdmin, `role=${refreshed?.user?.app_metadata?.role}`)

try {
  // Seed a prompt + entry for today
  const promptId = (await adminClient.rpc('dev_only_set_daily_prompt', {
    p_prompt_date: new Date().toISOString().slice(0, 10), p_prompt: 'admintest',
  })).data

  // Create an entry as a separate anonymous user (the "player")
  const playerClient = client()
  const { data: playerData } = await playerClient.auth.signInAnonymously()
  const playerId = playerData.user.id
  await playerClient.rpc('start_daily_attempt', { p_prompt_id: promptId })
  const strokes = [{ color: '#30a46c', width: 6, points: [100, 100, 110, 118] }]
  await playerClient.rpc('submit_daily_entry', { p_prompt_id: promptId, p_strokes: strokes })

  // List approved entries (entries are now auto-approved on submit)
  const list = await adminClient.rpc('admin_list_daily_entries', { p_status: 'approved', p_limit: 20 })
  check('admin-list', 'admin can list approved entries',
    !list.error && Array.isArray(list.data) && list.data.length >= 1,
    list.error ? `${code(list.error)} ${list.error.message}` : `rows=${list.data?.length}`)

  // Find the player's entry
  const entry = (list.data ?? []).find((e) => e.strokes && JSON.stringify(e.strokes).includes('#30a46c'))
  if (!entry) {
    console.log('  SKIP review tests: could not find the seeded entry')
  } else {
    // Verify entry is approved immediately after submit
    check('admin-auto-approve', 'submitted entry has status=approved', entry.status === 'approved', `status=${entry.status}`)

    // Approve is now a no-op (already approved), but should still succeed
    const approve = await adminClient.rpc('admin_review_daily_entry', { p_entry_id: entry.id, p_approve: true })
    check('admin-approve-noop', 'admin approve on already-approved entry succeeds (no-op)',
      !approve.error && approve.data?.changed === 0,
      approve.error ? `${code(approve.error)} ${approve.error.message}` : JSON.stringify(approve.data))

    // Check status remains approved
    const approvedCheck = await adminClient.rpc('admin_list_daily_entries', { p_prompt_date: null, p_status: 'approved', p_limit: 50 })
    const approvedEntry = (approvedCheck.data ?? []).find((e) => e.id === entry.id)
    check('admin-approve-status', 'entry still has status=approved after no-op approve',
      approvedEntry?.status === 'approved', `status=${approvedEntry?.status} err=${approvedCheck.error?.message}`)

    // Null p_approve
    const nullApprove = await adminClient.rpc('admin_review_daily_entry', { p_entry_id: entry.id, p_approve: null })
    check('admin-null', 'null p_approve rejected (22023)',
      code(nullApprove.error) === '22023', code(nullApprove.error))

    // Reject a second entry (create our own entry, don't depend on list paging)
    const player2Client = client()
    await player2Client.auth.signInAnonymously()
    await player2Client.rpc('start_daily_attempt', { p_prompt_id: promptId })
    await player2Client.rpc('submit_daily_entry', { p_prompt_id: promptId, p_strokes: [{ color: '#e5484d', width: 4, points: [50, 50, 60, 60] }] })
    const player2Entry = (await player2Client.from('daily_entries').select('id').eq('player_id', (await player2Client.auth.getUser()).data.user.id).single()).data

    const reject = await adminClient.rpc('admin_review_daily_entry', { p_entry_id: player2Entry.id, p_approve: false })
    check('admin-reject', 'admin can reject an entry',
      !reject.error && reject.data?.changed === 1,
      reject.error ? `${code(reject.error)} ${reject.error.message}` : JSON.stringify(reject.data))

    const rejectedCheck = await adminClient.rpc('admin_list_daily_entries', { p_prompt_date: null, p_status: 'rejected', p_limit: 50 })
    const rejectedEntry = (rejectedCheck.data ?? []).find((e) => e.id === player2Entry.id)
    check('admin-reject-status', 'rejected entry has status=rejected',
      rejectedEntry?.status === 'rejected', `status=${rejectedEntry?.status} err=${rejectedCheck.error?.message}`)

    // Stuck entry (started but never submitted) must not appear in the list
    const stuckClient = client()
    await stuckClient.auth.signInAnonymously()
    await stuckClient.rpc('start_daily_attempt', { p_prompt_id: promptId })
    // Don't submit — this entry has submitted_at = null
    const listAfter = await adminClient.rpc('admin_list_daily_entries', { p_status: 'approved', p_limit: 50 })
    const stuckEntry = (listAfter.data ?? []).find((e) => e.submitted_at === null)
    check('admin-stuck', 'unsubmitted (stuck) entries are not listed',
      !stuckEntry, stuckEntry ? 'found unsubmitted entry in list' : 'ok')

    // Approved entry becomes votable: vote_daily_entry on it (as another player) should succeed
    // (entry is already approved above)
    const voterClient = client()
    await voterClient.auth.signInAnonymously()
    // voter must have submitted today's entry to vote
    await voterClient.rpc('start_daily_attempt', { p_prompt_id: promptId })
    await voterClient.rpc('submit_daily_entry', { p_prompt_id: promptId, p_strokes: [{ color: '#f76b15', width: 3, points: [200, 200, 210, 210] }] })
    // Same-day voting: the approved entry from today's prompt is votable.
    const votable = await voterClient.rpc('vote_daily_entry', { p_entry_id: entry.id })
    check('admin-votable', 'approved same-day entry is votable', !votable.error,
      votable.error ? `${code(votable.error)} ${votable.error.message}` : `status=${approvedEntry?.status}`)

    // Additional check: rejected entry is removed from vote grid and cannot be voted on
    const gridAfterReject = await voterClient.rpc('get_daily_vote_grid', { p_limit: 12, p_offset: 0 })
    const rejectedInGrid = (gridAfterReject.data?.entries ?? []).some((e) => e.id === player2Entry.id)
    check('admin-reject-grid', 'rejected entry is removed from vote grid', !rejectedInGrid,
      rejectedInGrid ? 'rejected entry found in grid' : 'ok')

    const voteRejected = await voterClient.rpc('vote_daily_entry', { p_entry_id: player2Entry.id })
    check('admin-reject-vote', 'rejected entry cannot be voted on (22023)', code(voteRejected.error) === '22023', code(voteRejected.error))
  }
} finally {
  await adminClient.rpc('dev_only_set_admin', { p_enabled: false })
  console.log('  (admin revoked)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
