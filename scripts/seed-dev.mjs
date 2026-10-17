// Seed ~200 random valid strokes into the DEV Supabase project so load and
// RLS tests are meaningful. Usage:
//   set -a && source <(printf 'SUPABASE_URL=...\nVITE_SUPABASE_ANON_KEY=...\n') && set +a
//   node scripts/seed-dev.mjs [strokeCount]
// Creates a few anonymous users (which also exercises the players backfill
// and trigger once Phase 3 migrations are applied) and inserts strokes as
// each of them through the normal RLS policies — no service role needed.
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and VITE_SUPABASE_ANON_KEY (dev project) first.')
  process.exit(1)
}

const TOTAL = Number(process.argv[2] ?? 200)
const USERS = 3
const PAPER = 2000
const COLORS = ['#1d1d1f', '#e5484d', '#f76b15', '#f5a623', '#30a46c', '#0090ff', '#8e4ec6', '#e93d82']
const NAMES = ['Swift Otter', 'Quiet Fox', 'Bold Panda', 'Lucky Narwhal', 'Cosmic Gecko']

const rand = (min, max) => min + Math.random() * (max - min)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const quantize = (v) => Math.round(v * 10) / 10

function randomStroke() {
  const points = []
  let x = rand(50, PAPER - 50)
  let y = rand(50, PAPER - 50)
  const segments = Math.floor(rand(3, 40))
  for (let i = 0; i <= segments; i++) {
    points.push(quantize(x), quantize(y))
    x = Math.min(PAPER, Math.max(0, x + rand(-60, 60)))
    y = Math.min(PAPER, Math.max(0, y + rand(-60, 60)))
  }
  return {
    id: crypto.randomUUID(),
    user_name: pick(NAMES),
    color: pick(COLORS),
    width: quantize(rand(1, 40)),
    points,
    hidden: false,
  }
}

let inserted = 0
for (let u = 0; u < USERS; u++) {
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } })
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) {
    console.error('sign-in failed:', error.message)
    process.exit(1)
  }
  const userId = data.user.id
  const count = Math.round(TOTAL / USERS) + (u < TOTAL % USERS ? 1 : 0)
  const rows = Array.from({ length: count }, () => randomStroke())

  // chunked inserts to stay under request size limits
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25)
    const { error: insertError } = await supabase.from('strokes').insert(chunk)
    if (insertError) {
      console.error(`insert failed for user ${u} chunk ${i}:`, insertError.message)
      process.exit(1)
    }
    inserted += chunk.length
  }
  console.log(`user ${u + 1} (${userId}): ${count} strokes`)
}

console.log(`done: ${inserted} strokes total`)
