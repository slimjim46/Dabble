export const PAPER_SIZE = 2000
export const MIN_SCALE = 0.15
export const MAX_SCALE = 8

export const INK_MAX = 100
export const INK_REFILL_PER_SEC = 12

export const POINT_MIN_DIST_SCREEN = 2
export const SIMPLIFY_EPSILON_SCREEN = 0.6

export const MAX_NAME_LENGTH = 24
export const MAX_REMOTE_CURSORS = 50
export const CURSOR_FADE_AFTER_MS = 4000
export const CURSOR_REMOVE_AFTER_MS = 10000

// Realtime
export const CHANNEL_NAME = 'dabble:canvas:v1'
export const LIVE_FLUSH_MS = 70 // batch live stroke points
export const CURSOR_FLUSH_MS = 130 // throttle cursor broadcasts
// Must stay under strokeCodec's MAX_POINT_NUMBERS (8000 numbers = 4000 points)
export const MAX_LIVE_POINTS = 3000
