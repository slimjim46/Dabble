import { supabase } from './supabase.js'
import { decodePoints, isValidStroke, rowToStroke, strokeToRow } from './strokeCodec.js'

const COLUMNS = 'id,user_id,user_name,color,width,points,created_at'
const PAGE_SIZE = 1000 // Supabase returns at most 1000 rows per request
export const MAX_LOAD = 5000

const SNAPSHOT_BUCKET = 'snapshots'
const SNAPSHOT_IMAGE_TIMEOUT_MS = 8000

// Rows come from a shared table, so validate them like any other input.
function rowsToStrokes(rows) {
  const strokes = []
  for (const row of rows) {
    const wire = {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      color: row.color,
      width: row.width,
      points: row.points,
    }
    if (isValidStroke(wire)) strokes.push(rowToStroke(row))
  }
  return strokes
}

/**
 * Newest `limit` visible strokes, returned oldest -> newest so they draw in
 * the right order. Fetching newest-first means a canvas bigger than the cap
 * loses its oldest strokes rather than its latest ones.
 */
export async function fetchLatestStrokes(limit = MAX_LOAD) {
  const rows = []
  for (let from = 0; from < limit; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, limit) - 1
    const { data, error } = await supabase
      .from('strokes')
      .select(COLUMNS)
      .eq('hidden', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) throw error
    rows.push(...data)
    if (data.length < to - from + 1) break
  }
  rows.reverse()
  return {
    strokes: rowsToStrokes(rows),
    lastCreatedAt: rows.length ? rows[rows.length - 1].created_at : null,
  }
}

/** Strokes created at or after `since` (used to catch up after a reconnect). */
export async function fetchStrokesSince(since, limit = MAX_LOAD) {
  const rows = []
  for (let from = 0; from < limit; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, limit) - 1
    const { data, error } = await supabase
      .from('strokes')
      .select(COLUMNS)
      .eq('hidden', false)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw error
    rows.push(...data)
    if (data.length < to - from + 1) break
  }
  return {
    strokes: rowsToStrokes(rows),
    lastCreatedAt: rows.length ? rows[rows.length - 1].created_at : since,
  }
}

/**
 * The newest baked canvas, or null when none exists yet. The row is public
 * (RLS grants SELECT to everyone), so this works for anonymous visitors too.
 */
export async function fetchLatestSnapshot() {
  const { data, error } = await supabase
    .from('snapshots')
    .select('image_path,last_stroke_created_at,created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** Public URL of a snapshot object (the bucket is public-read). */
export function snapshotImageUrl(imagePath) {
  const { data } = supabase.storage.from(SNAPSHOT_BUCKET).getPublicUrl(imagePath)
  return data?.publicUrl ?? null
}

/**
 * Loads a snapshot PNG for drawImage(). crossOrigin is required so the browser
 * treats it as CORS-clean; a failure or an 8 s timeout rejects so the caller
 * can fall back to loading plain strokes.
 */
export function loadSnapshotImage(url, timeoutMs = SNAPSHOT_IMAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const timer = setTimeout(() => {
      image.onload = null
      image.onerror = null
      reject(new Error('snapshot image timed out'))
    }, timeoutMs)
    image.onload = () => {
      clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      clearTimeout(timer)
      reject(new Error('snapshot image failed to load'))
    }
    image.src = url
  })
}

/**
 * One hit-testing lookup against the baked snapshot: visible strokes whose
 * bounding box is within `radius` (world units) of the point, newest first.
 * Server output is validated like any other input.
 */
export async function strokesNear(x, y, radius) {
  const args = radius == null ? { p_x: x, p_y: y } : { p_x: x, p_y: y, p_radius: radius }
  const { data, error } = await supabase.rpc('strokes_near', args)
  if (error) throw error
  if (!Array.isArray(data)) return []
  const strokes = []
  for (const row of data) {
    const wire = {
      id: row?.id,
      userId: 'snapshot',
      userName: row?.user_name,
      color: row?.color,
      width: row?.width,
      points: row?.points,
    }
    if (!isValidStroke(wire)) continue
    strokes.push({
      id: row.id,
      userName: row.user_name,
      color: row.color,
      width: row.width,
      points: decodePoints(row.points),
    })
  }
  return strokes
}

/** Idempotent insert: re-sending the same stroke id is a no-op. */
export async function insertStroke(stroke, userId) {
  const row = { ...strokeToRow(stroke), user_id: userId }
  const { error } = await supabase
    .from('strokes')
    .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw error
}

/** Soft-delete (undo). RLS only lets you hide your own strokes. */
export async function hideStroke(id) {
  const { error } = await supabase.from('strokes').update({ hidden: true }).eq('id', id)
  if (error) throw error
}

/**
 * Used to verify a broadcast "remove" before trusting it: broadcasts can be
 * spoofed, the database can't. On any error we answer "visible" so a flaky
 * network never deletes someone's drawing.
 */
export async function isStrokeVisible(id) {
  const { data, error } = await supabase
    .from('strokes')
    .select('id')
    .eq('id', id)
    .eq('hidden', false)
    .maybeSingle()
  if (error) return true
  return Boolean(data)
}