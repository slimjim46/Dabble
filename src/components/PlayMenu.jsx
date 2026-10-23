import { useCallback, useEffect, useRef, useState } from 'react'
import { navigate } from '../lib/navigation.js'
import { dailyEntryHref } from '../daily/dailyEntry.js'
import { roomsEntryHref } from '../lib/roomsEntry.js'
import './PlayMenu.css'

const svgProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 20 20',
  fill: 'none',
  'aria-hidden': true,
}
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const ChevronIcon = () => (
  <svg {...svgProps} width="14" height="14" className="play-chevron">
    <path d="M6 7l4 4 4-4" {...stroke} strokeWidth="2" />
  </svg>
)
const CalendarIcon = () => (
  <svg {...svgProps} className="play-menu-icon">
    <rect x="2" y="4" width="16" height="14" rx="2" {...stroke} />
    <path d="M6 4v4M14 4v4M6 12h8" {...stroke} />
  </svg>
)
const ThumbsUpIcon = () => (
  <svg {...svgProps} className="play-menu-icon">
    <path d="M16.5 14.5c0 1.1-.9 2-2 2H5.5c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2h7.5" {...stroke} />
    <path d="M11 17v-6M7 11v6" {...stroke} />
  </svg>
)
const TrophyIcon = () => (
  <svg {...svgProps} className="play-menu-icon">
    <path d="M10 2l3 5h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z" {...stroke} />
    <path d="M6 13h12" {...stroke} />
  </svg>
)
const PlusIcon = () => (
  <svg {...svgProps} className="play-menu-icon">
    <path d="M10 4v12M4 10h12" {...stroke} />
  </svg>
)
const KeyboardIcon = () => (
  <svg {...svgProps} className="play-menu-icon">
    <rect x="2" y="4" width="16" height="12" rx="2" {...stroke} />
    <path d="M6 8h8M6 12h8" {...stroke} />
  </svg>
)

const CLOSE_MS = 200

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * PlayMenu: compact menu anchored below the Play pill.
 * State lives here so toggling never re-renders DrawingApp.
 */
export default function PlayMenu({ anchorRef, onClose }) {
  // 'closed' | 'open' | 'closing'. The ref mirrors it so the long-lived
  // window listeners below never read a stale value.
  const [phase, setPhaseState] = useState('closed')
  const phaseRef = useRef('closed')
  const closeTimerRef = useRef(null)
  const menuRef = useRef(null)

  const setPhase = useCallback((next) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const dailyHref = dailyEntryHref(import.meta.env)
  const roomsHref = roomsEntryHref(import.meta.env)

  const clearTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const finishClose = useCallback(() => {
    clearTimer()
    setPhase('closed')
    onClose?.()
  }, [clearTimer, setPhase, onClose])

  const closeMenu = useCallback(() => {
    if (phaseRef.current !== 'open') return
    if (reducedMotion()) {
      finishClose()
      return
    }
    setPhase('closing')
    clearTimer()
    // Fallback in case transitionend never fires.
    closeTimerRef.current = setTimeout(finishClose, CLOSE_MS)
  }, [clearTimer, finishClose, setPhase])

  const openMenu = () => {
    clearTimer()
    setPhase('open')
  }

  // Close on Escape, route change, and page hide.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') closeMenu()
    }
    const onHide = () => closeMenu()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('popstate', onHide)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onHide)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [closeMenu])

  // Never leave a timer running after unmount.
  useEffect(() => clearTimer, [clearTimer])

  // Dim layer catches taps, prevents stroke/pan underneath.
  const onDimDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
  }

  const onTransitionEnd = (e) => {
    if (
      e.target === menuRef.current &&
      e.propertyName === 'transform' &&
      phaseRef.current === 'closing'
    ) {
      finishClose()
    }
  }

  const go = (to) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
    navigate(to)
  }

  const onPillClick = () => {
    if (phaseRef.current === 'open') closeMenu()
    else if (phaseRef.current === 'closed') openMenu()
  }

  // Both entry points are gated by env flags; with neither there is nothing to show.
  if (!dailyHref && !roomsHref) return null

  const mounted = phase !== 'closed'
  const isOpen = phase === 'open'
  const dailyGallery = dailyHref ? `${dailyHref}/gallery` : null
  const dailyVote = dailyGallery ? `${dailyGallery}?tab=vote` : null

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`play-pill${isOpen ? ' play-pill-open' : ''}${phase === 'closing' ? ' play-pill-animating' : ''}`}
        onClick={onPillClick}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Play menu"
        title="Play"
      >
        Play
        <ChevronIcon />
      </button>

      {mounted && (
        <>
          <div
            className="play-dim"
            data-state={phase}
            style={phase === 'closing' ? { pointerEvents: 'none' } : undefined}
            onPointerDown={onDimDown}
            onTouchStart={onDimDown}
          />
          <div
            ref={menuRef}
            className="play-menu"
            role="menu"
            data-state={phase}
            onTransitionEnd={onTransitionEnd}
            style={{
              '--animation-duration': reducedMotion() ? '0ms' : '160ms',
              '--close-duration': reducedMotion() ? '0ms' : '120ms',
            }}
          >
            {dailyHref && (
              <>
                <a
                  className="play-menu-item play-menu-primary"
                  href={dailyHref}
                  onClick={go(dailyHref)}
                  role="menuitem"
                >
                  <CalendarIcon />
                  <div className="play-menu-primary-content">
                    <span className="play-menu-title">Daily Challenge</span>
                    <span className="play-menu-subtitle">2 minutes, one try</span>
                  </div>
                </a>

                <div className="play-menu-row">
                  <a
                    className="play-menu-item play-menu-half"
                    href={dailyVote}
                    onClick={go(dailyVote)}
                    role="menuitem"
                  >
                    <ThumbsUpIcon />
                    <span>Vote</span>
                  </a>
                  <a
                    className="play-menu-item play-menu-half"
                    href={dailyGallery}
                    onClick={go(dailyGallery)}
                    role="menuitem"
                  >
                    <TrophyIcon />
                    <span>Winners</span>
                  </a>
                </div>
              </>
            )}

            {dailyHref && roomsHref && <hr className="play-menu-divider" />}

            {roomsHref && (
              <>
                <a
                  className="play-menu-item play-menu-plain"
                  href={roomsHref}
                  onClick={go(roomsHref)}
                  role="menuitem"
                >
                  <PlusIcon />
                  <span>Create room</span>
                </a>
                {/* RoomsHome has no query-string join yet, so this is a plain /rooms link. */}
                <a
                  className="play-menu-item play-menu-plain"
                  href={roomsHref}
                  onClick={go(roomsHref)}
                  role="menuitem"
                >
                  <KeyboardIcon />
                  <span>Join with code</span>
                </a>
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}