// v2 Phase 5c-3: render daily challenge winners to PNG images.
//
//   node scripts/render-daily-winners.mjs [--dry-run]
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment only.
// The key is used to create one client; it is never written to disk, never put
// in a URL, and never printed (not even on error).
//
// Each run:
//   1. Finalizes every unfinalized prompt_date from today-8 up to today-2
//      (calls finalize_daily_winners for each, idempotent).
//   2. Renders any winner without an image (image_path is null, hidden = false).
//   3. For hidden winners that still have a stored image, deletes the file
//      via the Storage API and clears image_path.
//   4. Zero winners: logs "no winners", exits 0.
import { createClient } from '@supabase/supabase-js'
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodePoints } from '../src/lib/strokeCodec.js'

const BUCKET = 'snapshots'
const IMG_SIZE = 1080

const args = new Set(process.argv.slice(2))
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

// Register the bundled font (OFL-licensed Inter). Fallback: system default.

import { renderWinner as renderWinnerFn } from './lib/renderWinner.js'

function renderWinner(strokes, prompt) {
  return renderWinnerFn(strokes, prompt)
}

async function main() {
  const started = Date.now()
  let rendered = 0
  let pruned = 0

  // 1. Finalize every unfinalized prompt_date from today-8 up to today-2.
  const today = new Date()
  for (let i = 2; i <= 8; i++) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    const promptDate = d.toISOString().slice(0, 10)
    try {
      await supabase.rpc('finalize_daily_winners', { p_prompt_date: promptDate })
    } catch (e) {
      console.warn(`finalize ${promptDate}: ${e.message}`)
    }
  }

  // 2. Fetch unrendered winners (image_path is null, hidden = false).
  const { data: winners, error: wErr } = await supabase
    .from('daily_winners')
    .select('prompt_date, entry_id, votes, hidden, image_path')
    .is('image_path', null)
    .eq('hidden', false)
  if (wErr) throw new Error(`fetch winners: ${wErr.message}`)

  // 3. Fetch hidden winners that still have a stored image (takedown).
  const { data: hiddenWinners, error: hErr } = await supabase
    .from('daily_winners')
    .select('prompt_date, image_path')
    .eq('hidden', true)
    .not('image_path', 'is', null)
  if (hErr) throw new Error(`fetch hidden winners: ${hErr.message}`)

  // Takedown: delete stored images for hidden winners.
  for (const hw of hiddenWinners ?? []) {
    if (dryRun) {
      console.log(`takedown: would delete ${hw.image_path}`)
      continue
    }
    const { error: delErr } = await supabase.storage.from(BUCKET).remove([hw.image_path])
    if (delErr) console.warn(`takedown delete ${hw.image_path}: ${delErr.message}`)
    else {
      await supabase.from('daily_winners').update({ image_path: null }).eq('prompt_date', hw.prompt_date)
      pruned++
    }
  }

  // 4. Render unrendered winners.
  for (const w of winners ?? []) {
    if (!w.entry_id) {
      console.log(`no winner for ${w.prompt_date} (no approved entries with votes)`)
      continue
    }

    // Fetch the entry's strokes and the prompt text.
    const { data: entry, error: eErr } = await supabase
      .from('daily_entries')
      .select('strokes')
      .eq('id', w.entry_id)
      .single()
    if (eErr || !entry) {
      console.warn(`entry ${w.entry_id} not found: ${eErr?.message}`)
      continue
    }

    const { data: promptRow, error: pErr } = await supabase
      .from('daily_prompts')
      .select('prompt')
      .eq('prompt_date', w.prompt_date)
      .single()
    if (pErr || !promptRow) {
      console.warn(`prompt ${w.prompt_date} not found: ${pErr?.message}`)
      continue
    }

    const strokes = Array.isArray(entry.strokes) ? entry.strokes : []
    const canvas = renderWinner(strokes, promptRow.prompt)
    const png = canvas.toBuffer('image/png')

    const key = `daily/${w.prompt_date}/1.png`

    if (dryRun) {
      console.log(`render: ${w.prompt_date} → ${key} (${png.length} bytes, ${strokes.length} strokes)`)
      continue
    }

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(key, png, {
      contentType: 'image/png',
      cacheControl: '31536000',
      upsert: true,
    })
    if (uploadError) {
      console.warn(`upload ${key}: ${uploadError.message}`)
      continue
    }

    await supabase.from('daily_winners').update({ image_path: key }).eq('prompt_date', w.prompt_date)
    rendered++
    console.log(`rendered: ${w.prompt_date} → ${key} (${png.length} bytes)`)
  }

  if ((winners ?? []).length === 0 && (hiddenWinners ?? []).length === 0) {
    console.log('no winners')
  }

  console.log(`daily-winners: rendered=${rendered} pruned=${pruned} ${Date.now() - started} ms`)
}

main().catch((error) => {
  console.error(`daily-winners failed: ${error.message}`)
  process.exit(1)
})
