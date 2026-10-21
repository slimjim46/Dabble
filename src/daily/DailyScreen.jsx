import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createStrokeStore } from '../engine/strokeStore.js'
import { ensureAnonymousAuth, supabase } from '../lib/supabase.js'
import {
  amIBanned,
  classifyError,
  getMyEntry,
  getTodayPrompt,
  isBannedError,
  startDailyAttempt,
  submitDailyEntry,
} from './dailyApi.js'
import { clearDraft, loadDraft, saveDraft } from './dailyDraft.js'
import { entryBytes, toSubmitShape } from './dailyLimits.js'
import { attemptRemainingMs, humanCountdown, msToNextUtcMidnight } from './dailyTimer.js'
import { DAILY_ATTEMPT_SECONDS, DAILY_FULL_MARGIN_BYTES, DAILY_MAX_ENTRY_BYTES } from './constants.js'
import DailyPaper from './DailyPaper.jsx'
import VoteGrid from './VoteGrid.jsx'

const SUBMIT_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000, 8000]

export default function DailyScreen() {
  const store = useMemo(() => createStrokeStore(), [])
  const redrawRef = useRef(() => {})

  const [status, setStatus] = useState('loading') // loading|error|banned|no_prompt|ready|drawing|submitting|submitted|timed_out|submit_failed
  const [prompt, setPrompt] = useState(null) // { id, prompt }
  const [remainingMs, setRemainingMs] = useState(0)
  const [full, setFull] = useState(false)
  const [failReason, setFailReason] = useState('')
  const [nextPrompt, setNextPrompt] = useState('')

  const ref = useRef({
    entryId: null,
    startedAt: 0,
    offset: 0,
    retryDeadlineMs: 0,
    submitted: false,
  })

  const submit = useCallback(async () => {
    const s = ref.current
    if (!supabase || !prompt || s.submitted) return
    s.submitted = true
    setStatus('submitting')
    const strokes = toSubmitShape(Array.from(store.values()))
    let attempt = 0

    const once = async () => {
      const res = await submitDailyEntry(supabase, prompt.id, strokes)
      if (!res.error) {
        if (s.entryId) clearDraft(s.entryId)
        setStatus('submitted')
        return
      }
      if (isBannedError(res.error)) {
        setStatus('banned')
        return
      }
      if (classifyError(res.error) === 'permanent') {
        if (String(res.error.message ?? '').includes('already submitted')) {
          setStatus('submitted')
          return
        }
        setFailReason(String(res.error.message ?? 'Entry rejected'))
        setStatus('submit_failed')
        return
      }
      // Retryable: back off, but stop once the attempt+grace window has passed.
      const serverNow = Date.now() + s.offset
      if (serverNow >= s.retryDeadlineMs) {
        setFailReason('Time ran out before your entry could be saved.')
        setStatus('timed_out')
        return
      }
      const delay = SUBMIT_BACKOFF_MS[Math.min(attempt, SUBMIT_BACKOFF_MS.length - 1)]
      attempt += 1
      setTimeout(once, delay)
    }
    await once()
  }, [store, prompt])

  const beginDrawing = useCallback(
    async (id) => {
      // Idempotent: resume returns the original started_at + fresh server_now.
      const sentMs = Date.now()
      const res = await startDailyAttempt(supabase, id, { sentMs, receivedMs: Date.now() })
      if (res.error) {
        if (isBannedError(res.error)) setStatus('banned')
        else setStatus('error')
        return
      }
      ref.current.entryId = res.entryId
      ref.current.startedAt = res.startedAt
      ref.current.offset = res.offset
      ref.current.retryDeadlineMs = res.retryDeadlineMs
      ref.current.submitted = false

      const draft = loadDraft(res.entryId)
      if (draft && draft.length) store.addMany(draft)

      if (res.remainingMs <= 0) {
        setStatus('timed_out')
        return
      }
      setRemainingMs(res.remainingMs)
      setStatus('drawing')
    },
    [store],
  )

  // ---- load ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!supabase) {
        setStatus('error')
        return
      }
      try {
        const user = await ensureAnonymousAuth()
        if (cancelled) return
        if (!user) {
          setStatus('error')
          return
        }
        if (await amIBanned(supabase)) {
          if (!cancelled) setStatus('banned')
          return
        }
        const todayPrompt = await getTodayPrompt(supabase)
        if (cancelled) return
        if (!todayPrompt) {
          setStatus('no_prompt')
          return
        }
        setPrompt(todayPrompt)

        const entry = await getMyEntry(supabase, todayPrompt.id)
        if (cancelled) return
        if (entry?.submitted_at) {
          setStatus('submitted')
          return
        }
        if (entry) {
          // Resume an unsubmitted attempt (never creates an entry on load).
          await beginDrawing(todayPrompt.id)
          return
        }
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [beginDrawing])

  // ---- "new prompt in Xh Ym" ----------------------------------------------
  useEffect(() => {
    if (status !== 'no_prompt') return undefined
    const tick = () => setNextPrompt(humanCountdown(msToNextUtcMidnight(Date.now())))
    tick()
    const timer = setInterval(tick, 30000)
    return () => clearInterval(timer)
  }, [status])

  // ---- countdown + auto-submit --------------------------------------------
  useEffect(() => {
    if (status !== 'drawing') return undefined
    const tick = () => {
      const s = ref.current
      const rem = attemptRemainingMs(s.startedAt, Date.now() + s.offset, DAILY_ATTEMPT_SECONDS)
      setRemainingMs(rem)
      if (rem <= 0) {
        setStatus('submitting')
        submit()
      }
    }
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [status, submit])

  // ---- "paper full" --------------------------------------------------------
  const onCommit = useCallback(() => {
    const s = ref.current
    const strokes = Array.from(store.values())
    if (s.entryId) saveDraft(s.entryId, strokes)
    if (entryBytes(strokes) >= DAILY_MAX_ENTRY_BYTES - DAILY_FULL_MARGIN_BYTES) setFull(true)
  }, [store])

  const start = useCallback(async () => {
    if (!prompt) return
    await beginDrawing(prompt.id)
  }, [prompt, beginDrawing])

  const leave = useCallback(() => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])

  return (
    <div className="daily-screen">
      <div className="daily-top">
        <div className="daily-top-left">
          {status === 'drawing' && (
            <span className="daily-clock" role="timer">
              {Math.max(0, Math.ceil(remainingMs / 1000))}s
            </span>
          )}
          {prompt && (
            <span className="daily-prompt" title="Today's prompt">
              {prompt.prompt}
            </span>
          )}
          {status === 'ready' && <span className="daily-note">2 minutes, one try</span>}
        </div>
        <div className="daily-bar">
          <button type="button" className="daily-link" onClick={leave}>
            Back
          </button>
        </div>
      </div>

      {status === 'loading' && <p className="daily-note">Loading…</p>}

      {status === 'error' && (
        <div className="daily-note">
          <p>Could not reach the daily challenge.</p>
          <button type="button" className="daily-button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      {status === 'banned' && <p className="daily-note">You cannot play the daily challenge right now.</p>}

      {status === 'no_prompt' && (
        <div className="daily-note">
          <p>No challenge today — check back later.</p>
          <p>New prompt in {nextPrompt}.</p>
        </div>
      )}

      {status === 'ready' && (
        <div className="daily-actions">
          <button type="button" className="daily-button" onClick={start}>
            Start
          </button>
        </div>
      )}

      {(status === 'drawing' || status === 'submitting' || status === 'submit_failed') && (
        <>
          <DailyPaper store={store} onCommit={onCommit} disabled={full || status !== 'drawing'} redrawRef={redrawRef} />
          <div className="daily-actions">
            {status === 'drawing' && (
              <button type="button" className="daily-button" onClick={submit}>
                Done
              </button>
            )}
            {status === 'submitting' && <span className="daily-note">Saving…</span>}
            {status === 'submit_failed' && <span className="daily-note">{failReason}</span>}
            {full && <span className="daily-note">Paper full — press Done to submit.</span>}
          </div>
        </>
      )}

      {status === 'submitted' && (
        <div className="daily-note">
          <p>Entry in review.</p>
          <p>Come back tomorrow to see and vote on entries.</p>
        </div>
      )}

      {status === 'submitted' && (
        <div className="daily-vote-section">
          <h2 className="daily-heading">Vote on yesterday's entries</h2>
          <VoteGrid supabase={supabase} />
        </div>
      )}

      {status === 'timed_out' && (
        <div className="daily-note">
          <p>Time's up — this attempt wasn't saved.</p>
          <p>Come back tomorrow for a new prompt.</p>
        </div>
      )}
    </div>
  )
}
