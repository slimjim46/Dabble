// Dev-only load test for the realtime canvas (Phase 7h).
//
//   LOADTEST_ALLOWED_URL="$SUPABASE_URL" node scripts/loadtest.mjs
//
// It refuses to run unless SUPABASE_URL is an exact match for
// LOADTEST_ALLOWED_URL. The script signs in real anonymous users, broadcasts
// real strokes and persists them, so aiming it at a project has to be a
// deliberate, explicit act every time — never an accident of the environment.
//
// Per client it exercises, in the same shapes the browser uses:
//   - anonymous sign-in, channel subscribe (bounded by a timeout) and presence
//   - stroke_start / stroke_points / stroke_end, verified against src/lib/wire.js
//     before the run starts, so a payload the receivers would drop cannot
//     silently make the test meaningless
//   - cursor broadcasts while not drawing
//   - the same INSERT path the browser's persist queue takes
// and it counts every broadcast it receives back from the other clients.
//
// Afterwards every visible stroke on the board is hidden with the dev-only
// helper dev_only_hide_all_strokes, so a run does not leave scribbles behind.
//
// Env:
//   LOADTEST_ALLOWED_URL   required; must equal SUPABASE_URL exactly
//   SUPABASE_ANON_KEY      public anon key (VITE_SUPABASE_ANON_KEY also read)
//   LOADTEST_CLIENTS       default 10
//   LOADTEST_DURATION_MS   default 30000
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

import { CHANNEL_NAME, PAPER_SIZE } from '../src/lib/constants.js'
import { encodePoints, quantize } from '../src/lib/strokeCodec.js'
import { MAX_LIVE_BATCH_NUMBERS, parseCursor, parseStrokeEnd, parseStrokePoints, parseStrokeStart } from '../src/lib/wire.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const ALLOWED_URL = process.env.LOADTEST_ALLOWED_URL

// Same list as src/hooks/useRealtimeCanvas.js: we listen for everything the
// app can receive.
const BROADCAST_EVENTS = ['stroke_start', 'stroke_points', 'stroke_end', 'stroke_cancel', 'stroke_remove', 'cursor']

const SUBSCRIBE_TIMEOUT_MS = 15000
const SIGN_IN_STAGGER_MS = 120
const STROKE_CYCLE_MS = 2500 // one stroke per client every 2.5 s
const BATCH_TICK_MS = 70 // mirrors LIVE_FLUSH_MS
const CURSOR_TICK_MS = 400
const POINTS_PER_BATCH = 60 // even, and well under MAX_LIVE_BATCH_NUMBERS
const INK_COLORS = ['#1d1d1f', '#e0483c', '#2f6fed', '#2fae5f', '#f5a623']
const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'JP', 'BR', 'CA', 'AU', 'IN', 'ZA']

function intEnv(name, fallback, lo, hi) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.min(hi, Math.max(lo, Math.floor(raw)))
}

const NUM_CLIENTS = intEnv('LOADTEST_CLIENTS', 10, 1, 100)
const DURATION_MS = intEnv('LOADTEST_DURATION_MS', 30000, 2000, 600000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by)
}

function refuse(message) {
  console.error(message)
  process.exit(1)
}

function checkEnvironment() {
  if (typeof WebSocket === 'undefined') {
    // realtime-js builds its socket client eagerly, so createClient throws on
    // Node.js < 22. Say so plainly instead of dumping a stack trace.
    refuse('This script needs a global WebSocket: run it with Node.js 22 or newer.')
  }
  if (!SUPABASE_URL || !ANON_KEY) {
    refuse('Set SUPABASE_URL and an anon key (SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY).')
  }
  if (!ALLOWED_URL) {
    refuse(
      [
        'LOADTEST_ALLOWED_URL is not set.',
        'This script creates real users, broadcasts real strokes and writes rows, so it',
        'must be aimed at a project on purpose:',
        '',
        '  LOADTEST_ALLOWED_URL="<your SUPABASE_URL>" node scripts/loadtest.mjs',
      ].join('\n'),
    )
  }
  if (SUPABASE_URL !== ALLOWED_URL) {
    refuse(
      [
        'REFUSING: SUPABASE_URL does not match LOADTEST_ALLOWED_URL.',
        `  SUPABASE_URL:         ${SUPABASE_URL}`,
        `  LOADTEST_ALLOWED_URL: ${ALLOWED_URL}`,
      ].join('\n'),
    )
  }
}

/** A short wandering stroke somewhere on the paper, in wire-ready shape. */
function makeStroke(userId, userName) {
  let x = 100 + Math.random() * (PAPER_SIZE - 200)
  let y = 100 + Math.random() * (PAPER_SIZE - 200)
  let angle = Math.random() * Math.PI * 2
  const points = []
  const count = 40 + Math.floor(Math.random() * 40)
  for (let i = 0; i < count; i++) {
    points.push({ x, y })
    angle += (Math.random() - 0.5) * 0.7
    x = Math.min(PAPER_SIZE, Math.max(0, x + Math.cos(angle) * (4 + Math.random() * 8)))
    y = Math.min(PAPER_SIZE, Math.max(0, y + Math.sin(angle) * (4 + Math.random() * 8)))
  }
  return {
    id: crypto.randomUUID(),
    userId,
    userName,
    color: INK_COLORS[Math.floor(Math.random() * INK_COLORS.length)],
    width: 2 + Math.floor(Math.random() * 6),
    points,
  }
}

/**
 * Prove the payloads we are about to broadcast are the ones src/lib/wire.js
 * accepts on the receiving side. If this ever fails, the load test would be
 * measuring dropped messages rather than the system under load.
 */
function selfCheckPayloads() {
  const userId = crypto.randomUUID()
  const k = crypto.randomUUID()
  const stroke = makeStroke(userId, 'Load0')
  const flat = encodePoints(stroke.points)
  const wireStroke = {
    id: stroke.id,
    userId,
    userName: stroke.userName,
    color: stroke.color,
    width: stroke.width,
    points: flat,
  }

  const payloadChecks = [
    ['stroke_start', parseStrokeStart({ k, id: stroke.id, userId, userName: stroke.userName, color: stroke.color, width: stroke.width, pts: flat.slice(0, 2) })],
    ['stroke_points', parseStrokePoints({ k, id: stroke.id, seq: 1, pts: flat.slice(2, 2 + POINTS_PER_BATCH) })],
    ['stroke_end', parseStrokeEnd({ k, stroke: wireStroke })],
    ['cursor', parseCursor({ k, x: quantize(123.4), y: quantize(678.9) })],
  ]
  const rejected = payloadChecks.filter(([, accepted]) => !accepted).map(([name]) => name)
  if (rejected.length > 0) {
    refuse(`REFUSING to run: src/lib/wire.js would drop these payloads: ${rejected.join(', ')}`)
  }
  if (POINTS_PER_BATCH > MAX_LIVE_BATCH_NUMBERS) {
    refuse(`REFUSING to run: a ${POINTS_PER_BATCH}-number batch exceeds MAX_LIVE_BATCH_NUMBERS`)
  }
}

/** Subscribe with a timeout, so a stuck channel is an error, not a hang. */
function subscribe(channel) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new Error(`subscribe timed out after ${SUBSCRIBE_TIMEOUT_MS} ms`)),
      SUBSCRIBE_TIMEOUT_MS,
    )

    const subscription = channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') finish(resolve, undefined)
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        finish(reject, new Error(error?.message ?? status))
      }
    })
    // The promise settles the same way; the callback above is the one place
    // errors are handled, so duplicates are swallowed here.
    Promise.resolve(subscription).catch(() => {})
  })
}

/** Send one broadcast the way the browser does: fire, then count the reply. */
function send(channel, event, payload, stats) {
  if (channel.state !== 'joined') {
    stats.sendFailed++
    return
  }
  // channel.send() resolves with a plain string: 'ok' | 'error' | 'timed out'.
  const count = (result) => {
    if (result === 'ok') stats.sent++
    else {
      stats.sendFailed++
      bump(stats.sendErrors, typeof result === 'string' ? result : 'unknown')
    }
  }
  try {
    Promise.resolve(channel.send({ type: 'broadcast', event, payload }))
      .then(count)
      .catch((error) => {
        stats.sendFailed++
        bump(stats.sendErrors, error?.message ?? 'throw')
      })
  } catch (error) {
    stats.sendFailed++
    bump(stats.sendErrors, error?.message ?? 'throw')
  }
}

/** Draw strokes at a human rate until the deadline, and save each one. */
async function driveTraffic({ client, channel, stats, key, userId, userName, deadline }) {
  const persist = async (stroke, flat) => {
    const row = {
      id: stroke.id,
      user_id: userId,
      user_name: userName,
      color: stroke.color,
      width: stroke.width,
      points: flat,
      hidden: false,
    }
    try {
      const { error } = await client
        .from('strokes')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      if (error) {
        stats.insertFailed++
        bump(stats.insertErrors, error.code ?? error.message)
      } else {
        stats.inserted++
      }
    } catch (error) {
      stats.insertFailed++
      bump(stats.insertErrors, error?.message ?? 'throw')
    }
  }

  while (Date.now() < deadline) {
    if (channel.state !== 'joined') break
    const cycleStart = Date.now()
    const stroke = makeStroke(userId, userName)
    const flat = encodePoints(stroke.points)
    const wireStroke = {
      id: stroke.id,
      userId,
      userName,
      color: stroke.color,
      width: stroke.width,
      points: flat,
    }

    let seq = 0
    send(channel, 'stroke_start', {
      k: key,
      id: stroke.id,
      userId,
      userName,
      color: stroke.color,
      width: stroke.width,
      pts: flat.slice(0, 2),
    }, stats)

    for (let i = 2; i < flat.length; i += POINTS_PER_BATCH) {
      if (Date.now() >= deadline) break
      seq++
      send(channel, 'stroke_points', { k: key, id: stroke.id, seq, pts: flat.slice(i, i + POINTS_PER_BATCH) }, stats)
      await sleep(BATCH_TICK_MS)
    }

    send(channel, 'stroke_end', { k: key, stroke: wireStroke }, stats)
    await persist(stroke, flat)

    // Cursors move around between strokes, the way a visitor does when their
    // pen is off the paper.
    const until = Math.min(deadline, cycleStart + STROKE_CYCLE_MS)
    while (Date.now() < until) {
      if (channel.state !== 'joined') break
      send(channel, 'cursor', {
        k: key,
        x: quantize(Math.random() * PAPER_SIZE),
        y: quantize(Math.random() * PAPER_SIZE),
      }, stats)
      await sleep(CURSOR_TICK_MS)
    }
  }
}

async function runClient(index, deadline, signedIn) {
  const stats = {
    index,
    received: new Map(),
    sent: 0,
    sendFailed: 0,
    sendErrors: new Map(),
    inserted: 0,
    insertFailed: 0,
    insertErrors: new Map(),
    presencePeak: 0,
    error: null,
  }
  const key = crypto.randomUUID()
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 40 } },
  })

  try {
    const { data, error } = await client.auth.signInAnonymously()
    if (error) throw new Error(`sign-in failed: ${error.message}`)
    const userId = data.user?.id
    if (!userId) throw new Error('sign-in returned no user id')
    signedIn.push(client)

    const userName = `Load${index + 1}`
    const channel = client.channel(CHANNEL_NAME, {
      config: { broadcast: { self: false }, presence: { key } },
    })

    for (const event of BROADCAST_EVENTS) {
      channel.on('broadcast', { event }, () => bump(stats.received, event))
    }
    channel.on('presence', { event: 'sync' }, () => {
      const size = Object.keys(channel.presenceState()).length
      if (size > stats.presencePeak) stats.presencePeak = size
    })

    await subscribe(channel)
    await Promise.resolve(
      channel.track({
        name: userName,
        color: INK_COLORS[index % INK_COLORS.length],
        country: COUNTRIES[index % COUNTRIES.length],
      }),
    ).catch(() => {})

    await driveTraffic({ client, channel, stats, key, userId, userName, deadline })

    await Promise.resolve(channel.unsubscribe()).catch(() => {})
  } catch (error) {
    stats.error = error?.message ?? String(error)
    try {
      await Promise.resolve(client.removeAllChannels()).catch(() => {})
    } catch {
      // nothing left to clean up
    }
  }
  return stats
}

function total(map) {
  let sum = 0
  for (const value of map.values()) sum += value
  return sum
}

function formatBreakdown(map) {
  const parts = [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

function main() {
  checkEnvironment()
  selfCheckPayloads()

  const host = new URL(SUPABASE_URL).host
  console.log(`load test against ${host} (allowed by LOADTEST_ALLOWED_URL)`)
  console.log(
    `clients ${NUM_CLIENTS}, duration ${DURATION_MS} ms — each client signs in anonymously first; ` +
      'Supabase allows 30 anonymous sign-ins per hour per IP out of the box (this dev project is raised to 1000/h). ' +
      'If sign-ins fail, lower LOADTEST_CLIENTS.',
  )

  const started = Date.now()
  const deadline = started + DURATION_MS
  const signedIn = []

  const tasks = []
  for (let i = 0; i < NUM_CLIENTS; i++) {
    // Stagger sign-ins: a burst of anonymous sign-ins from one IP is exactly
    // what the rate limit is there to stop.
    tasks.push(sleep(i * SIGN_IN_STAGGER_MS).then(() => runClient(i, deadline, signedIn)))
  }

  return Promise.all(tasks).then(async (results) => {
    const elapsedMs = Math.max(1, Date.now() - started)

    // Leave the board clean: this is dev, and strokes are real rows.
    let hidden = null
    let hideError = null
    if (signedIn.length > 0) {
      try {
        const { data, error } = await signedIn[0].rpc('dev_only_hide_all_strokes')
        if (error) hideError = error.message
        else hidden = data
      } catch (error) {
        hideError = error?.message ?? String(error)
      }
    } else {
      hideError = 'no client signed in'
    }

    const joined = results.filter((r) => !r.error)
    const received = new Map()
    const sendErrors = new Map()
    const insertErrors = new Map()
    let sent = 0
    let sendFailed = 0
    let inserted = 0
    let insertFailed = 0
    let presencePeak = 0
    for (const r of results) {
      for (const [event, count] of r.received) bump(received, event, count)
      for (const [reason, count] of r.sendErrors) bump(sendErrors, reason, count)
      for (const [reason, count] of r.insertErrors) bump(insertErrors, reason, count)
      sent += r.sent
      sendFailed += r.sendFailed
      inserted += r.inserted
      insertFailed += r.insertFailed
      presencePeak = Math.max(presencePeak, r.presencePeak)
    }
    const receivedTotal = total(received)
    const seconds = elapsedMs / 1000

    console.log('')
    for (const r of results) {
      console.log(`  client ${r.index + 1}: ${r.error ? `FAILED — ${r.error}` : `${total(r.received)} received, ${r.sent} sent, ${r.inserted} saved, presence peak ${r.presencePeak}`}`)
    }
    console.log('')
    console.log(`  clients joined     ${joined.length}/${results.length}`)
    console.log(`  elapsed            ${seconds.toFixed(1)} s`)
    console.log(`  messages received  ${receivedTotal} (${(receivedTotal / seconds).toFixed(1)}/s across all clients)`)
    console.log(`    by event         ${formatBreakdown(received)}`)
    console.log(`  messages sent      ${sent} ok, ${sendFailed} failed${sendFailed ? ` (${formatBreakdown(sendErrors)})` : ''}`)
    console.log(`  presence peak      ${presencePeak}`)
    console.log(`  strokes saved      ${inserted} ok, ${insertFailed} failed${insertFailed ? ` (${formatBreakdown(insertErrors)})` : ''}`)
    console.log(
      hidden !== null
        ? `  canvas cleared     ${hidden} stroke(s) hidden by dev_only_hide_all_strokes`
        : `  canvas cleared     FAILED — ${hideError}`,
    )

    const problems = []
    if (joined.length !== results.length) problems.push(`${results.length - joined.length} client(s) failed to run`)
    if (sent === 0) problems.push('nothing was broadcast')
    if (receivedTotal === 0) problems.push('no broadcast came back (needs at least 2 clients)')
    if (hideError) problems.push('strokes were not hidden')

    if (problems.length > 0) {
      console.error(`\nFAIL: ${problems.join('; ')}`)
      process.exitCode = 1
    } else {
      console.log('\nOK')
    }
  })
}

main().catch((error) => {
  console.error(`load test crashed: ${error?.stack ?? error}`)
  process.exit(1)
})
