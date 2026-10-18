// Phase 5a: render the canvas to a PNG snapshot in the 'snapshots' bucket.
//
//   node scripts/render-snapshot.mjs [--full] [--dry-run]
//
// Every snapshot lands as a 2000x2000 PNG (what clients draw) plus a 1200x630
// JPEG preview (what /api/snapshot-latest redirects scrapers to).
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment only.
// The key is used to create one client; it is never written to disk, never put
// in a URL, and never printed (not even on error).
//
// Incremental by default: start from the previous snapshot PNG and draw only
// visible strokes newer than snapshots.last_stroke_created_at, up to a 10-minute
// cutoff (SNAPSHOT_SETTLE) so very recent strokes stay vector on the client and
// own-undo keeps working. A full rebuild (blank paper + every visible stroke)
// happens with --full, when the previous snapshot is older than 24 h, or when a
// stroke that was already baked in had its visibility changed since then
// (admin hide, report auto-hide, ban-with-hide, admin restore).
//
// If nothing changed, nothing is uploaded. Only the newest 24 snapshots are
// kept; older ones are deleted by exact row id and object path.
import { createClient } from '@supabase/supabase-js'
import { createCanvas, loadImage } from '@napi-rs/canvas'

import { PAPER_SIZE } from '../src/lib/constants.js'
import { drawStroke } from '../src/lib/stroke.js'
import { decodePoints } from '../src/lib/strokeCodec.js'

const PAGE_SIZE = 1000
const KEEP_SNAPSHOTS = 24
const SNAPSHOT_SETTLE_MS = 10 * 60 * 1000
const FULL_MAX_AGE_MS = 24 * 60 * 60 * 1000
const BUCKET = 'snapshots'
// Open Graph wants a landscape image; every scraper we care about asks for
// roughly this box. The full PNG stays the source of truth for clients.
const PREVIEW_WIDTH = 1200
const PREVIEW_HEIGHT = 630
const JPEG_QUALITY = 0.82

const args = new Set(process.argv.slice(2))
const forcedFull = args.has('--full')
const dryRun = args.has('--dry-run')

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.')
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Object key for a new snapshot: snapshots/<iso-timestamp>.png (bucket-relative). */
function snapshotKey(date) {
  return `${date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}.png`
}

/** Object key of the OG preview that accompanies a full PNG snapshot. */
function previewKey(pngKey) {
  return pngKey.endsWith('.png') ? `${pngKey.slice(0, -4)}.jpg` : `${pngKey}.jpg`
}

/**
 * The same canvas at 1200x630, letterboxed on white: the whole square paper
 * stays visible instead of being cropped to the middle band.
 */
function renderPreview(source) {
  const canvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const scale = Math.min(PREVIEW_WIDTH / PAPER_SIZE, PREVIEW_HEIGHT / PAPER_SIZE)
  const width = PAPER_SIZE * scale
  const height = PAPER_SIZE * scale
  ctx.drawImage(source, (PREVIEW_WIDTH - width) / 2, (PREVIEW_HEIGHT - height) / 2, width, height)
  return canvas.toBuffer('image/jpeg', JPEG_QUALITY)
}

/** Page a query 1000 rows at a time, ordered (created_at, id). */
async function fetchStrokes(applyFilters) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('strokes')
      .select('id,created_at,user_name,color,width,points')
      .eq('hidden', false)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    query = applyFilters(query)
    const { data, error } = await query
    if (error) throw new Error(`strokes page ${from}: ${error.message}`)
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

async function previousSnapshot() {
  const { data, error } = await supabase
    .from('snapshots')
    .select('id,image_path,created_at,last_stroke_created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`read previous snapshot: ${error.message}`)
  return data
}

/** True if any baked-in stroke changed visibility since the previous snapshot. */
async function hasStaleBake(prev) {
  const { count, error } = await supabase
    .from('strokes')
    .select('id', { count: 'exact', head: true })
    .gt('hidden_at', prev.created_at)
    .lte('created_at', prev.last_stroke_created_at)
  if (error) throw new Error(`check hidden changes: ${error.message}`)
  return (count ?? 0) > 0
}

async function prune() {
  const { data, error } = await supabase
    .from('snapshots')
    .select('id,image_path,preview_path')
    .order('created_at', { ascending: false })
  if (error) throw new Error(`list snapshots: ${error.message}`)
  const stale = data.slice(KEEP_SNAPSHOTS)
  for (const row of stale) {
    const objects = [row.image_path]
    if (row.preview_path) objects.push(row.preview_path)
    const { error: objectError } = await supabase.storage.from(BUCKET).remove(objects)
    if (objectError) throw new Error(`remove object ${objects.join(', ')}: ${objectError.message}`)
    const { error: rowError } = await supabase.from('snapshots').delete().eq('id', row.id)
    if (rowError) throw new Error(`delete snapshot row: ${rowError.message}`)
  }
  return stale.length
}

async function main() {
  const started = Date.now()
  const prev = await previousSnapshot()
  const cutoff = new Date(Date.now() - SNAPSHOT_SETTLE_MS)

  let full = forcedFull || !prev
  let reason = forcedFull ? '--full' : 'no previous snapshot'
  if (!full && Date.parse(prev.created_at) < Date.now() - FULL_MAX_AGE_MS) {
    full = true
    reason = 'previous snapshot older than 24 h'
  }
  if (!full && (await hasStaleBake(prev))) {
    full = true
    reason = 'a baked-in stroke changed visibility'
  }

  const canvas = createCanvas(PAPER_SIZE, PAPER_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PAPER_SIZE, PAPER_SIZE)

  let strokes
  if (full) {
    strokes = await fetchStrokes((q) => q.lte('created_at', cutoff.toISOString()))
  } else {
    strokes = await fetchStrokes((q) =>
      q.gt('created_at', prev.last_stroke_created_at).lte('created_at', cutoff.toISOString()),
    )
    const blob = await downloadBase(prev.image_path)
    const base = await loadImage(Buffer.from(await blob.arrayBuffer()))
    ctx.drawImage(base, 0, 0)
  }

  for (const row of strokes) {
    drawStroke(ctx, {
      color: row.color,
      width: row.width,
      points: decodePoints(row.points),
    })
  }

  const lastBaked = strokes.length > 0 ? strokes[strokes.length - 1].created_at : cutoff.toISOString()
  const changed = full || strokes.length > 0

  if (!changed) {
    console.log(
      `strokes drawn: 0 | mode: ${full ? 'full' : 'incremental'} | png: 0 bytes | ${Date.now() - started} ms | no changes, skipped`,
    )
    return
  }

  const png = canvas.toBuffer('image/png')
  const preview = renderPreview(canvas)

  if (dryRun) {
    console.log(
      `strokes drawn: ${strokes.length} | mode: ${full ? 'full' : 'incremental'} | png: ${png.length} bytes | jpg: ${preview.length} bytes | ${Date.now() - started} ms | dry-run, not uploaded`,
    )
    return
  }

  const key = snapshotKey(new Date())
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(key, png, {
    contentType: 'image/png',
    cacheControl: '31536000',
    upsert: false,
  })
  if (uploadError) throw new Error(`upload ${key}: ${uploadError.message}`)

  // The preview is recorded only if it actually landed: a NULL preview_path
  // makes /api/snapshot-latest fall back to the PNG instead of 404-ing.
  const previewObject = previewKey(key)
  let previewPath = null
  const { error: previewError } = await supabase.storage.from(BUCKET).upload(previewObject, preview, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
    upsert: false,
  })
  if (previewError) {
    console.warn(`preview upload failed (${previewError.message}) — OG image falls back to the PNG`)
  } else {
    previewPath = previewObject
  }

  const { error: insertError } = await supabase
    .from('snapshots')
    .insert({ image_path: key, preview_path: previewPath, last_stroke_created_at: lastBaked })
  if (insertError) throw new Error(`insert snapshot row: ${insertError.message}`)

  const pruned = await prune()

  console.log(
    `strokes drawn: ${strokes.length} | mode: ${full ? 'full' : 'incremental'} (${reason}) | png: ${png.length} bytes | jpg: ${preview.length} bytes${previewPath ? '' : ' (preview not stored)'} | ${Date.now() - started} ms | kept newest ${KEEP_SNAPSHOTS}, pruned ${pruned}`,
  )
}

async function downloadBase(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`download base ${path}: ${error?.message ?? 'empty'}`)
  return data
}

main().catch((error) => {
  console.error(`snapshot failed: ${error.message}`)
  process.exit(1)
})
