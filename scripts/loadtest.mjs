import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const NUM_CLIENTS = Number(process.env.LOADTEST_CLIENTS || 20)
const DURATION_MS = Number(process.env.LOADTEST_DURATION_MS || 30000)
const CHANNEL = 'dabble:canvas:v1'

if (!URL || !ANON) {
  console.error('missing env')
  process.exit(1)
}

function newStroke(userId, userName) {
  const id = crypto.randomUUID()
  const x1 = Math.random() * 2000, y1 = Math.random() * 2000
  const x2 = x1 + (Math.random()-0.5)*50, y2 = y1 + (Math.random()-0.5)*50
  return {
    id,
    userId,
    userName,
    color: '#1d1d1f',
    width: 6,
    points: [{x:x1,y:y1},{x:x2,y:y2}],
    t: Date.now()
  }
}

async function runClient(i) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  let userId = null
  try {
    const { data, error } = await c.auth.signInAnonymously()
    if (error) throw error
    userId = data.user?.id
  } catch (e) {
    return { i, sent:0, err: e.message }
  }
  const ch = c.channel(CHANNEL)
  await new Promise((res, rej) => ch.subscribe((st) => { if (st==='SUBSCRIBED') res(); else if (st==='CHANNEL_ERROR') rej(); }))
  let sent = 0
  const end = Date.now() + DURATION_MS
  const t = setInterval(() => {
    if (Date.now() >= end) { clearInterval(t); ch.unsubscribe(); return }
    const s = newStroke(userId, `Load${i}`)
    ch.send({ type: 'broadcast', event: 'stroke', payload: s })
    sent++
  }, 1000)
  await new Promise((r) => setInterval(() => { if (Date.now() >= end) r() }, 500))
  ch.unsubscribe()
  return { i, sent }
}

async function main() {
  const tasks = Array.from({length:NUM_CLIENTS}, (_,i)=>runClient(i))
  const res = await Promise.all(tasks)
  console.log(JSON.stringify(res, null, 2))
  process.exit(0)
}
main()
