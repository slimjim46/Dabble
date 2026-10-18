// Phase 5a: render the canvas to a PNG snapshot in the 'snapshots' bucket.
//
//   node scripts/render-snapshot.mjs [--full] [--dry-run]
//
// Every snapshot lands as a 2000x2000 PNG (what clients draw) plus a 1200x630
// JPEG preview cropped to the busiest band (what /api/snapshot-latest
// redirects scrapers to).
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
import { busiestBandTop } from '../src/lib/ogPreview.js'
import { previewKey, snapshotKey } from '../src/lib/snapshotKey.js'
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

// Ink is sampled on a square grid: one getImageData over 200x200 cells instead
// of one over the full 2000x2000 canvas, which is what makes the scan cheap.
const PREVIEW_SAMPLE = 200

/** Ink per sampled row of the rendered paper (index 0 is the top row). */
function inkProfile(source) {
  const sample = createCanvas(PREVIEW_SAMPLE, PREVIEW_SAMPLE)
  const ctx = sample.getContext('2d')
  ctx.drawImage(source, 0, 0, PREVIEW_SAMPLE, PREVIEW_SAMPLE)
  const { data } = ctx.getImageData(0, 0, PREVIEW_SAMPLE, PREVIEW_SAMPLE)
  const rowInk = new Array(PREVIEW_SAMPLE).fill(0)
  for (let i = 0; i < PREVIEW_SAMPLE * PREVIEW_SAMPLE; i++) {
    const p = i * 4
    // The paper is pure white, so anything off it is a stroke (antialiasing
    // and all). A cell with a single drawn pixel in it counts as ink.
    if (data[p] < 250 || data[p + 1] < 250 || data[p + 2] < 250) rowInk[(i / PREVIEW_SAMPLE) | 0]++
  }
  return rowInk
}

/**
 * The 1200x630 OG preview: a full-width band of the square paper, as tall as
 * the preview's aspect allows, sitting over the busiest part of the board (the
 * middle band when nothing is drawn). Cropping instead of letterboxing fills
 * the frame with the drawing — a letterboxed square on white bars reads as a
 * broken image in a link preview.
 */
function renderPreview(source) {
  const bandHeight = Math.round(PAPER_SIZE * (PREVIEW_HEIGHT / PREVIEW_WIDTH))
  const bandRows = Math.round(PREVIEW_SAMPLE * (PREVIEW_HEIGHT / PREVIEW_WIDTH))
  const rowUnit = PAPER_SIZE / PREVIEW_SAMPLE
  const top = Math.min(
    PAPER_SIZE - bandHeight,
    busiestBandTop(inkProfile(source), bandRows) * rowUnit,
  )

  const canvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
  ctx.drawImage(source, 0, top, PAPER_SIZE, bandHeight, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)
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
