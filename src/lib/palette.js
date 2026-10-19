// The only colours a room stroke may carry on the wire, and the only brush
// ids. Three copies have to agree, so tests/roomClient.test.mjs fails the
// moment they drift:
//   - this file (what the room client renders and sends),
//   - rooms/src/config.js PALETTE / BRUSH_IDS (what the server validates),
//   - COLORS in src/components/Toolbar.jsx (what the plaza offers).
// The server is the authority: a colour outside PALETTE is rejected, never
// silently corrected, so the client must send exactly these.
export const PALETTE = Object.freeze([
  '#1d1d1f',
  '#e5484d',
  '#f76b15',
  '#f5a623',
  '#30a46c',
  '#0090ff',
  '#8e4ec6',
  '#e93d82',
])

export const BRUSH_IDS = Object.freeze([0])

export const DEFAULT_COLOR = PALETTE[0]

/**
 * A stable palette colour for an id we have no colour for yet (a player's
 * cursor before their first stroke). Deriving it rather than inventing a hex
 * string keeps every drawn colour inside PALETTE, which is the whole point of
 * a closed list.
 */
export function colorForKey(key) {
  let hash = 0
  const text = typeof key === 'string' ? key : ''
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}
