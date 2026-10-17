import { CURSOR_FADE_AFTER_MS, CURSOR_REMOVE_AFTER_MS } from '../lib/constants.js'

const MAX_TRACKED = 200

/**
 * Remote cursor positions (world coordinates) plus who they belong to.
 * Positions come from Broadcast; names/colors come from Presence.
 */
export function createCursorStore() {
  const positions = new Map() // key -> { x, y, t }, ordered oldest -> newest
  const info = new Map() // key -> { name, color }

  return {
    update(key, x, y, now = performance.now()) {
      positions.delete(key) // re-insert so Map order tracks recency
      positions.set(key, { x, y, t: now })
      if (positions.size > MAX_TRACKED) {
        positions.delete(positions.keys().next().value)
      }
    },

    setInfo(key, name, color) {
      info.set(key, { name, color })
    },

    remove(key) {
      positions.delete(key)
      info.delete(key)
    },

    prune(now = performance.now()) {
      for (const [key, p] of positions) {
        if (now - p.t > CURSOR_REMOVE_AFTER_MS) positions.delete(key)
      }
    },

    /** Cursors to draw: most recently active first, capped, with a fade alpha. */
    visible(now, cap) {
      const out = []
      for (const [key, p] of positions) {
        const idle = now - p.t
        if (idle >= CURSOR_REMOVE_AFTER_MS) continue
        const alpha =
          idle <= CURSOR_FADE_AFTER_MS
            ? 1
            : 1 - (idle - CURSOR_FADE_AFTER_MS) / (CURSOR_REMOVE_AFTER_MS - CURSOR_FADE_AFTER_MS)
        const meta = info.get(key)
        out.push({
          key,
          x: p.x,
          y: p.y,
          t: p.t,
          alpha,
          name: meta?.name ?? 'Guest',
          color: meta?.color ?? '#6b6b73',
        })
      }
      if (out.length > cap) {
        out.sort((a, b) => b.t - a.t)
        out.length = cap
      }
      return out
    },

    /** True while any cursor is mid-fade, so the renderer keeps animating. */
    isFading(now) {
      for (const p of positions.values()) {
        const idle = now - p.t
        if (idle > CURSOR_FADE_AFTER_MS && idle < CURSOR_REMOVE_AFTER_MS) return true
      }
      return false
    },

    get size() {
      return positions.size
    },
  }
}