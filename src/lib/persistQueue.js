import { hideStroke, insertStroke } from './strokeApi.js'

const MAX_ATTEMPTS = 10

// Postgres integrity/permission errors will never succeed on retry.
function isPermanent(error) {
  return /^(22|23|42)/.test(String(error?.code ?? ''))
}

function retryDelay(attempts) {
  return Math.min(30000, 1000 * 2 ** attempts) * (0.75 + Math.random() * 0.5)
}

/**
 * Saves finished strokes in the background. Drawing never waits on it:
 * failures retry with backoff, and `retryNow()` is called when the browser
 * comes back online.
 */
export function createPersistQueue({ getUserId }) {
  const entries = new Map()

  function schedule(entry, delay) {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => run(entry), delay)
  }

  async function run(entry) {
    if (entries.get(entry.stroke.id) !== entry || entry.inflight) return
    entry.inflight = true
    try {
      const userId = await getUserId()
      if (!userId) throw new Error('not signed in yet')
      await insertStroke(entry.stroke, userId)
      entries.delete(entry.stroke.id)
      // Undo was pressed while the insert was in flight: hide it now.
      if (entry.cancelled) await hideStroke(entry.stroke.id).catch(() => {})
    } catch (error) {
      entry.attempts += 1
      if (entry.cancelled || isPermanent(error) || entry.attempts >= MAX_ATTEMPTS) {
        entries.delete(entry.stroke.id)
        if (!entry.cancelled) console.error('[dabble] could not save stroke', error)
      } else {
        schedule(entry, retryDelay(entry.attempts))
      }
    } finally {
      entry.inflight = false
    }
  }

  return {
    add(stroke) {
      const entry = { stroke, attempts: 0, inflight: false, cancelled: false, timer: 0 }
      entries.set(stroke.id, entry)
      run(entry)
    },

    /**
     * Undo before the stroke reached the database. Returns true when the
     * insert was dropped before being sent (nothing to hide in the DB).
     */
    cancel(id) {
      const entry = entries.get(id)
      if (!entry) return false
      entry.cancelled = true
      if (entry.inflight) return false
      clearTimeout(entry.timer)
      entries.delete(id)
      return true
    },

    retryNow() {
      for (const entry of entries.values()) {
        if (!entry.inflight) schedule(entry, 0)
      }
    },

    get size() {
      return entries.size
    },
  }
}