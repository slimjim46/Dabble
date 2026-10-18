// Phase 5a acceptance tests for the snapshot pipeline, against DEV.
//
// Seeds strokes as an anonymous user, ages them past SNAPSHOT_SETTLE with the
// service role, runs scripts/render-snapshot.mjs as a child process, and checks
// the PNG/row it produces: full vs incremental, pixel contents, no-change
// skips, stale-bake rebuilds, strokes_near visibility, and that clients cannot
// write the bucket or the snapshots table.
//
// Run:
//   set -a && source <dev env with SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//                        SUPABASE_SERVICE_ROLE_KEY>
//   set +a && node tests/snapshot.test.mjs
//
// The service-role key is only read from the environment; it is never printed.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const SUPA_URL = process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev).')
  process.exit(1)
}

const SCRIPT = fileURLToPath(new URL('../scripts/render-snapshot.mjs', import.meta.url))
const BUCKET = 'snapshots'

let pass = 0
let fail = 0
function check(n, label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${n}  ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${n}  ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
const { data: auth, error: authError } = await anon.auth.signInAnonymously()
if (authError) {
  console.error(`anonymous sign-in failed: ${authError.message}`)
  process.exit(1)
}
const svc = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

// Deterministic bake: clear whatever is on the dev canvas so the only visible
// strokes are the ones this test seeds (dev-only helper; the board is emptied
// again in cleanup).
await anon.rpc('dev_only_hide_all_strokes')

function runScript(...flags) {
  const result = spawnSync(process.execPath, [SCRIPT, ...flags], {
    encoding: 'utf8',
    env: process.env,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.status !== 0) console.log(`      script stderr: ${stderr.trim()}`)
  return { status: result.status, stdout, stderr }
}

const drawnCount = (stdout) => {
  const m = stdout.match(/strokes drawn:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

async function insertStroke(stroke) {
  const { error } = await anon.from('strokes').insert(stroke)
  if (error) throw new Error(`seed stroke failed: ${error.message}`)
  return stroke.id
}

async function backdate(ids, msAgo) {
  const stamp = new Date(Date.now() - msAgo).toISOString()
  const { error } = await svc.from('strokes').update({ created_at: stamp }).in('id', ids)
  if (error) throw new Error(`backdate failed: ${error.message}`)
}

async function snapshotRows() {
  const { data, error } = await svc
    .from('snapshots')
    .select('id,image_path,preview_path,created_at,last_stroke_created_at')
    .order('created_at', { ascending: false })
  if (error) throw new Error(`list snapshots failed: ${error.message}`)
  return data
}

async function download(path) {
  const { data, error } = await svc.storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`download ${path} failed: ${error?.message ?? 'empty'}`)
  return Buffer.from(await data.arrayBuffer())
}

async function pixel(path, x, y) {
  const img = await loadImage(await download(path))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data
  return { r, g, b, a }
}

/** Non-white pixels in the first `xLimit` columns of an image buffer. */
async function inkInColumns(buf, xLimit) {
  const img = await loadImage(buf)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, Math.min(xLimit, img.width), img.height)
  let ink = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) ink++
  }
  return ink
}

const isRed = (p) => p.r > 200 && p.g < 80 && p.b < 80
const isBlue = (p) => p.b > 200 && p.r < 80 && p.g < 80
const isWhite = (p) => p.r > 250 && p.g > 250 && p.b > 250

const strokeIds = []
const before = new Set((await snapshotRows()).map((r) => r.id))

// ---- 1: a full first snapshot -------------------------------------------
const oldStroke = {
  id: crypto.randomUUID(),
  user_name: 'Snapshot Test',
  color: '#ff0000',
  width: 20,
  points: [100, 200, 300, 200],
  hidden: false,
}
strokeIds.push(await insertStroke(oldStroke))
await backdate([oldStroke.id], 40 * 60 * 1000) // older than the settle window

let run = runScript()
let rows = await snapshotRows()
const created = rows.find((r) => !before.has(r.id))
check('full-first', 'first run builds a full snapshot and records the row',
  run.status === 0 && run.stdout.includes('mode: full') && created,
  `status=${run.status} stdout=${run.stdout.trim()}`)

check('row', 'the snapshot row points at an existing object in the bucket',
  created?.image_path?.endsWith('.png') && (await download(created.image_path)).length > 0,
  `image_path=${created?.image_path}`)

const bakedPixel = created ? await pixel(created.image_path, 200, 200) : null
check('pixel-baked', 'the seeded stroke is drawn into the PNG',
  bakedPixel && isRed(bakedPixel), `pixel=${JSON.stringify(bakedPixel)}`)

const publicUrl = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${created?.image_path}`
const publicRes = await fetch(publicUrl)
check('public-read', 'the snapshot is publicly readable without a key',
  publicRes.status === 200, `status=${publicRes.status}`)
await publicRes.arrayBuffer()

// ---- 1b: the 1200x630 OG preview, and the endpoint that serves it ---------
{
  const previewBuf = created?.preview_path ? await download(created.preview_path) : null
  check('preview-object', 'the row points at a real JPEG object in the bucket',
    created?.preview_path?.endsWith('.jpg') && previewBuf?.[0] === 0xff && previewBuf?.[1] === 0xd8,
    `preview_path=${created?.preview_path} bytes=${previewBuf?.length}`)

  const previewImg = previewBuf ? await loadImage(previewBuf) : null
  check('preview-size', 'the preview is 1200x630, the shape scrapers ask for',
    previewImg && previewImg.width === 1200 && previewImg.height === 630,
    previewImg ? `${previewImg.width}x${previewImg.height}` : 'unreadable')

  // The seeded stroke starts at canvas x=100, which a full-width crop puts
  // near the left edge of the frame — inside the white bar a letterboxed
  // preview would leave there.
  const leftInk = previewBuf ? await inkInColumns(previewBuf, 250) : 0
  check('preview-crop', 'the preview is cropped to the drawing, not letterboxed with white bars',
    leftInk > 0, `non-white pixels left of x=250: ${leftInk}`)
}

// The endpoint must reach the snapshot with the PUBLIC key: run it while the
// service role key is unset, so a handler that ever reaches for it fails here.
{
  const { default: snapshotLatest } = await import('../api/snapshot-latest.js')
  const savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const savedAnonKey = process.env.SUPABASE_ANON_KEY
  const res = {
    statusCode: 0,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    end() {
      return this
    },
  }
  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.SUPABASE_ANON_KEY = ANON
    await snapshotLatest({ method: 'GET' }, res)
  } finally {
    if (savedServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey
    if (savedAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY
    else process.env.SUPABASE_ANON_KEY = savedAnonKey
  }
  const location = res.headers.Location ?? ''
  check('og-redirect', 'the OG endpoint redirects to the preview JPEG without the service role key',
    res.statusCode === 302 && location.endsWith('.jpg') && location.includes(created?.preview_path ?? ' '),
    `status=${res.statusCode} location=${location}`)
}

// ---- 2: incremental draws only the new stroke ----------------------------
const newStroke = {
  id: crypto.randomUUID(),
  user_name: 'Snapshot Test',
  color: '#0000ff',
  width: 20,
  points: [100, 400, 300, 400],
  hidden: false,
}
strokeIds.push(await insertStroke(newStroke))
await backdate([newStroke.id], 20 * 60 * 1000) // after the old one, before the cutoff

run = runScript()
const incRow = (await snapshotRows()).find((r) => !before.has(r.id) && r.id !== created?.id)
const incPixelNew = incRow ? await pixel(incRow.image_path, 200, 400) : null
const incPixelOld = incRow ? await pixel(incRow.image_path, 200, 200) : null
check('incremental', 'the second run is incremental and draws exactly the new stroke',
  run.status === 0 && run.stdout.includes('mode: incremental') && drawnCount(run.stdout) === 1,
  `status=${run.status} drawn=${drawnCount(run.stdout)}`)
check('incremental-pixels', 'the new stroke is on top of the previous PNG (old stroke preserved)',
  incPixelNew && isBlue(incPixelNew) && incPixelOld && isRed(incPixelOld),
  `new=${JSON.stringify(incPixelNew)} old=${JSON.stringify(incPixelOld)}`)

// ---- 3: nothing changed -> nothing uploaded ------------------------------
const countBeforeNoop = (await snapshotRows()).length
run = runScript()
const countAfterNoop = (await snapshotRows()).length
check('no-change', 'a no-change run uploads nothing and says so',
  run.status === 0 && run.stdout.includes('no changes, skipped') && countAfterNoop === countBeforeNoop,
  `status=${run.status} before=${countBeforeNoop} after=${countAfterNoop}`)

// ---- 4: hiding a baked-in stroke triggers a full rebuild -----------------
await anon.from('strokes').update({ hidden: true }).eq('id', oldStroke.id)
run = runScript()
const fullRow = (await snapshotRows()).find(
  (r) => !before.has(r.id) && r.id !== created?.id && r.id !== incRow?.id,
)
const fullPixelOld = fullRow ? await pixel(fullRow.image_path, 200, 200) : null
const fullPixelNew = fullRow ? await pixel(fullRow.image_path, 200, 400) : null
check('stale-bake', 'hiding an already-baked stroke forces a full rebuild',
  run.status === 0 && run.stdout.includes('mode: full') && /changed visibility|older than 24/.test(run.stdout),
  `status=${run.status} stdout=${run.stdout.trim()}`)
check('stale-pixel', 'the rebuilt PNG no longer contains the hidden stroke but keeps the visible one',
  fullPixelOld && isWhite(fullPixelOld) && fullPixelNew && isBlue(fullPixelNew),
  `old=${JSON.stringify(fullPixelOld)} new=${JSON.stringify(fullPixelNew)}`)

// ---- 5: strokes_near -----------------------------------------------------
const nearVisible = { id: crypto.randomUUID(), user_name: 'Snapshot Test', color: '#00ff00', width: 8, points: [1000, 1000, 1100, 1000], hidden: false }
const nearHidden = { id: crypto.randomUUID(), user_name: 'Snapshot Test', color: '#00ffff', width: 8, points: [1000, 1001, 1100, 1001], hidden: false }
const farStroke = { id: crypto.randomUUID(), user_name: 'Snapshot Test', color: '#ff00ff', width: 8, points: [1150, 1000, 1250, 1000], hidden: false }
for (const s of [nearVisible, nearHidden, farStroke]) {
  strokeIds.push(await insertStroke(s))
}
await anon.from('strokes').update({ hidden: true }).eq('id', nearHidden.id)

const { data: near, error: nearError } = await anon.rpc('strokes_near', { p_x: 1050, p_y: 1000, p_radius: 8 })
const nearIds = Array.isArray(near) ? near.map((s) => s.id) : []
const shapeOk = Array.isArray(near) && near.every(
  (s) => Object.keys(s).sort().join(',') === 'color,id,points,user_name,width',
)
check('near-visible-only', 'strokes_near returns the visible hit and hides the hidden one',
  !nearError && nearIds.includes(nearVisible.id) && !nearIds.includes(nearHidden.id),
  `error=${nearError?.message} ids=${nearIds.join(',')}`)

const { data: wide, error: wideError } = await anon.rpc('strokes_near', { p_x: 1050, p_y: 1000, p_radius: 10000 })
const wideIds = Array.isArray(wide) ? wide.map((s) => s.id) : []
check('near-radius-cap', 'radius is capped at 40 (a stroke 100px away stays out) and the shape is exact',
  !wideError && shapeOk && wideIds.includes(nearVisible.id) && !wideIds.includes(farStroke.id),
  `error=${wideError?.message} ids=${wideIds.join(',')} shape=${shapeOk}`)

const noAuth = createClient(SUPA_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
const { error: anonNearError } = await noAuth.rpc('strokes_near', { p_x: 1050, p_y: 1000 })
check('near-auth', 'strokes_near is unavailable without a session',
  Boolean(anonNearError), anonNearError ? '' : 'accepted')

// ---- 6: clients cannot write snapshots -----------------------------------
const { error: rowWriteError } = await anon
  .from('snapshots')
  .insert({ image_path: 'client-write.png', last_stroke_created_at: new Date().toISOString() })
const { error: uploadError } = await anon.storage
  .from(BUCKET)
  .upload('client-write-test.png', Buffer.from([1, 2, 3]), { contentType: 'image/png' })
// The storage API answers a denied delete with "data: [], error: null", so the
// only reliable check is that the object is still there afterwards.
await anon.storage.from(BUCKET).remove([created.image_path])
const { data: listing } = await svc.storage.from(BUCKET).list('', { search: created.image_path })
const survived = (listing ?? []).some((o) => o.name === created.image_path)
check('no-client-writes', 'clients cannot insert snapshot rows or upload, and their delete removes nothing',
  Boolean(rowWriteError) && Boolean(uploadError) && survived,
  `row=${rowWriteError ? 'denied' : 'ALLOWED'} upload=${uploadError ? 'denied' : 'ALLOWED'} object-survived=${survived}`)

// ---- cleanup -------------------------------------------------------------
// Delete only the exact rows/objects/ strokes this test created.
{
  const now = await snapshotRows()
  for (const row of now.filter((r) => !before.has(r.id))) {
    const objects = row.preview_path ? [row.image_path, row.preview_path] : [row.image_path]
    await svc.storage.from(BUCKET).remove(objects)
    await svc.from('snapshots').delete().eq('id', row.id)
  }
  await svc.from('strokes').delete().in('id', strokeIds)
  await svc.storage.from(BUCKET).remove(['client-write-test.png'])
  const { data: hidden } = await anon.rpc('dev_only_hide_all_strokes')
  console.log(`\ncleanup: ${strokeIds.length} test stroke(s) removed, ${hidden} leftover stroke(s) hidden`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
