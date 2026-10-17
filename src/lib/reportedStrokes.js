// Strokes the local visitor reported: hidden for them immediately, whether or
// not the server reached the hide threshold. A Set, persisted in
// localStorage, and filtered out of the paper-cache rebuild.
const KEY = 'dabble:reported'
const MAX_IDS = 500

let cached = null

function load() {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    cached = new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : [])
  } catch {
    cached = new Set()
  }
  return cached
}

export function isReported(id) {
  return load().has(id)
}

export function markReported(id) {
  const set = load()
  if (set.has(id)) return
  set.add(id)
  if (set.size > MAX_IDS) {
    const oldest = set.values()
    for (let i = 0; i < set.size - MAX_IDS; i++) set.delete(oldest.next().value)
  }
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]))
  } catch {
    // storage full or unavailable: the Set still works for this session
  }
}

/** Filters an iterable of strokes down to the ones the visitor should see. */
export function visibleToMe(strokes) {
  if (cached === null || cached.size === 0) return strokes
  const out = []
  for (const stroke of strokes) {
    if (!cached.has(stroke.id)) out.push(stroke)
  }
  return out
}
