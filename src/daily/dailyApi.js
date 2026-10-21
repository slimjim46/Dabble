// RPC wrappers for the daily challenge, and the retry classification that
// matches AGENTS.md's invariants: invalid data (22023) and banned (42501) are
// PERMANENT (a retry can never succeed); everything else is retryable.
import { DAILY_ATTEMPT_SECONDS, DAILY_GRACE_SECONDS } from './constants.js'
import { attemptRemainingMs, computeOffset, retryDeadlineMs } from './dailyTimer.js'

const PERMANENT_CODES = new Set(['22023', '42501'])

export function classifyError(error) {
  if (!error) return 'none'
  return PERMANENT_CODES.has(String(error?.code ?? '')) ? 'permanent' : 'retryable'
}

export function isBannedError(error) {
  return String(error?.code ?? '') === '42501'
}

/** Today's UTC date string 'YYYY-MM-DD' (the challenge day boundary). */
export function todayUtcDate() {
  return new Date().toISOString().slice(0, 10)
}

export async function getTodayPrompt(supabase) {
  const { data, error } = await supabase
    .from('daily_prompts')
    .select('id, prompt')
    .eq('prompt_date', todayUtcDate())
    .maybeSingle()
  if (error) throw error
  return data
}

/** My own entry for a prompt (RLS returns own rows only). */
export async function getMyEntry(supabase, promptId) {
  const { data, error } = await supabase
    .from('daily_entries')
    .select('id, started_at, submitted_at, status')
    .eq('prompt_id', promptId)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Am I banned? Reads my own players row (players_select_own). */
export async function amIBanned(supabase) {
  const { data, error } = await supabase.from('players').select('banned').maybeSingle()
  if (error) throw error
  return data?.banned === true
}

/**
 * Start (or resume) the attempt. Idempotent: on resume it returns the original
 * started_at plus a fresh server_now, so a refresh continues the same
 * countdown instead of restarting it.
 */
export async function startDailyAttempt(supabase, promptId, { sentMs, receivedMs }) {
  const { data, error } = await supabase.rpc('start_daily_attempt', { p_prompt_id: promptId })
  if (error) return { error }
  const serverNow = new Date(data.server_now).getTime()
  const { offset, marginMs } = computeOffset(serverNow, sentMs, receivedMs)
  const startedAt = new Date(data.started_at).getTime()
  return {
    entryId: data.entry_id,
    startedAt,
    offset,
    marginMs,
    // Remaining on the countdown (attempt only, not grace).
    remainingMs: attemptRemainingMs(startedAt, serverNow, DAILY_ATTEMPT_SECONDS),
    // The hard deadline for retrying a failed submit.
    retryDeadlineMs: retryDeadlineMs(startedAt, DAILY_ATTEMPT_SECONDS, DAILY_GRACE_SECONDS),
  }
}

export async function submitDailyEntry(supabase, promptId, strokes) {
  return supabase.rpc('submit_daily_entry', { p_prompt_id: promptId, p_strokes: strokes })
}
