export const PAPER_SIZE = 2000
export const MIN_SCALE = 0.15
export const MAX_SCALE = 8

export const INK_MAX = 100
export const INK_REFILL_PER_SEC = 12

// Client-side stroke splitting (Phase 4 step 0b): when one stroke's accrued
// cost (path length * width / 800) reaches this, close it and start a new one.
// Must stay below INK_SERVER_CAPACITY (150) or the final piece would be
// permanently rejected by the server with 22023.
export const STROKE_SPLIT_COST = 100

// Server-side mirrors of public.dabble_limits()
// (supabase/migrations/20261017230200_phase6_limits_trigger.sql). Change both
// together: the database is the authority, these only shape client UX.
export const INK_SERVER_CAPACITY = 150 // 1.5 x INK_MAX
export const MAX_STROKES_PER_MINUTE = 60
export const MAX_REPORTS_TO_HIDE = 3
export const MIN_REPORTER_AGE_MINUTES = 10
export const MAX_REPORTS_PER_MINUTE = 10
export const MAX_RENAMES_PER_HOUR = 5

// Incoming flood protection (receivers cannot be validated by the database).
export const REMOTE_LIVE_STROKE_LIMIT = 200
export const REMOTE_STARTS_PER_WINDOW = 12
export const REMOTE_STARTS_WINDOW_MS = 10000
export const REMOTE_POINTS_PER_MINUTE = 12000

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
