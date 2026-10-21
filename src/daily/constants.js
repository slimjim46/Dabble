// Client mirrors of the daily challenge limits. The database is the authority:
// these mirror public.dabble_daily_limits() (attempt/grace) and the
// daily-relevant numbers in public.dabble_limits(). tests/dailyClient.test.mjs
// queries both functions and fails if these drift. The stroke SHAPE limits
// (width 1..40, points 2..8000, coords 0..2000) live in src/lib/constants.js
// and src/lib/strokeCodec.js and are reused, not re-mirrored.
export const DAILY_ATTEMPT_SECONDS = 120
export const DAILY_GRACE_SECONDS = 10
export const DAILY_INK_CAPACITY = 150
export const DAILY_REFILL_PER_SEC = 12
export const DAILY_MAX_STROKES_PER_MINUTE = 60
export const DAILY_STROKE_CAP = DAILY_MAX_STROKES_PER_MINUTE * 2
export const DAILY_INK_BUDGET = DAILY_INK_CAPACITY + DAILY_REFILL_PER_SEC * DAILY_ATTEMPT_SECONDS

// Mirrors the 256 KiB cap in supabase/migrations/20261022000100_phase5b_daily_size_cap.sql.
export const DAILY_MAX_ENTRY_BYTES = 262144
// The paper goes "full" this far below the cap, so a final stroke can never
// push a valid drawing over the limit (a single stroke is far smaller).
export const DAILY_FULL_MARGIN_BYTES = 64 * 1024
