/**
 * Holds every committed stroke (keyed by id, so duplicates from the database,
 * broadcasts and our own echoes can never render twice) plus the in-progress
 * strokes of other people, keyed by their tab key.
 *
 * Lives outside React: the hot path (drawing, remote points) never re-renders.
 * Events: 'add' (one stroke), 'remove' (one id), 'bulk' (many added), 'meta'.
 */
import { REMOTE_LIVE_STROKE_LIMIT } from '../lib/constants.js'
export function createStrokeStore() {
  const strokes = new Map()
  const live = new Map()
  const listeners = new Set()

  const emit = (type, payload) => {
    for (const listener of listeners) listener(type, payload)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    // ---- committed strokes -------------------------------------------------
    has: (id) => strokes.has(id),
    get: (id) => strokes.get(id),
    values: () => strokes.values(),
    get size() {
      return strokes.size
    },

    add(stroke) {
      if (strokes.has(stroke.id)) return false
      strokes.set(stroke.id, stroke)
      emit('add', stroke)
      return true
    },

    addMany(list) {
      let added = 0
      for (const stroke of list) {
        if (strokes.has(stroke.id)) continue
        strokes.set(stroke.id, stroke)
        added += 1
      }
      if (added > 0) emit('bulk')
      return added
    },

    remove(id) {
      const had = strokes.delete(id)
      if (had) emit('remove', id)
      return had
    },

    lastOwn(userId) {
      let found = null
      for (const stroke of strokes.values()) {
        if (stroke.userId === userId) found = stroke
      }
      return found
    },

    hasOwn(userId) {
      for (const stroke of strokes.values()) {
        if (stroke.userId === userId) return true
      }
      return false
    },

    // The guest id is replaced by the auth user id once sign-in finishes.
    reassignUser(oldId, newId) {
      if (oldId === newId) return
      let changed = false
      for (const stroke of strokes.values()) {
        if (stroke.userId === oldId) {
          stroke.userId = newId
          changed = true
        }
      }
      if (changed) emit('meta')
    },

    // ---- other people's in-progress strokes --------------------------------
    // Capped so a hostile sender cannot exhaust memory with fake live strokes;
    // extra starts beyond the cap are ignored (returns false).
    startLive(key, stroke) {
      if (!live.has(key) && live.size >= REMOTE_LIVE_STROKE_LIMIT) return false
      live.set(key, { ...stroke, seq: 0, updatedAt: performance.now() })
      return true
    },
    getLive: (key) => live.get(key),
    endLive(key, id) {
      const current = live.get(key)
      if (!current || (id && current.id !== id)) return false
      live.delete(key)
      return true
    },
    liveStrokes: () => live.values(),

    // Drop every in-progress stroke at once. Used when the round ends (the
    // drawer's line is never completed once mayDraw flips, so without this a
    // watcher keeps a ghost line until it prunes): the reveal frame clears it.
    clearLive() {
      const had = live.size > 0
      live.clear()
      return had
    },

    // Someone who disconnects mid-stroke would otherwise leave a ghost line.
    pruneStaleLive(now, maxAgeMs) {
      let pruned = false
      for (const [key, stroke] of live) {
        if (now - stroke.updatedAt > maxAgeMs) {
          live.delete(key)
          pruned = true
        }
      }
      return pruned
    },
  }
}