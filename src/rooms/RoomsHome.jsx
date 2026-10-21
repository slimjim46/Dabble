import { useRef, useState } from 'react'
import { ensureCaptchaToken } from '../lib/turnstile.js'
import { createRoomsAuth } from './roomsAuth.js'
import { ROOM_CODE_RE } from './roomsConfig.js'
import { createRoom } from './roomsWire.js'

/**
 * `/rooms`: make a room, or type a friend's five-character code. Nothing here
 * draws; the whole screen is one form and one button, and the code is validated
 * here so a typo never costs a round trip.
 */
export default function RoomsHome({ roomsUrl, onJoin }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  const trimmed = code.trim().toUpperCase()

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY
      const turn = siteKey ? await ensureCaptchaToken(siteKey) : null
      if (siteKey && !turn) {
        setError('The human check did not finish. Try again in a moment.')
        return
      }
      const result = await createRoom({ roomsUrl, auth: createRoomsAuth(), turn })
      if (!result.ok) {
        setError(CREATE_ERRORS[result.error] ?? CREATE_ERRORS.unreachable)
        return
      }
      onJoin(result.code)
    } finally {
      setBusy(false)
    }
  }

  const join = (event) => {
    event.preventDefault()
    setError(null)
    if (!ROOM_CODE_RE.test(trimmed)) {
      setError('Room codes are five letters and numbers, with no O, I, L or 1.')
      inputRef.current?.focus()
      return
    }
    onJoin(trimmed)
  }

  return (
    <div className="rooms-home">
      <div className="rooms-card">
        <h1 className="rooms-title">DoodleScrap Rooms</h1>
        <p className="rooms-sub">
          A private canvas for you and up to eleven others. Anyone with the code can join — rooms are not listed
          anywhere.
        </p>

        <button type="button" className="rooms-create" onClick={create} disabled={busy || !roomsUrl}>
          {busy ? 'Creating…' : 'Create a room'}
        </button>

        <form className="rooms-join" onSubmit={join}>
          <label className="rooms-label" htmlFor="room-code">
            or join with a code
          </label>
          <div className="rooms-join-row">
            <input
              ref={inputRef}
              id="room-code"
              className="rooms-input"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCDE"
              maxLength={5}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
            <button type="submit" className="rooms-join-button" disabled={!roomsUrl}>
              Join
            </button>
          </div>
        </form>

        {error && (
          <p className="rooms-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

const CREATE_ERRORS = {
  auth: 'Could not sign you in. Try reloading the page.',
  origin: 'This page is not allowed to create rooms.',
  banned: 'You cannot create rooms right now.',
  rate_limited: 'You are creating rooms too quickly. Try again shortly.',
  busy: 'The rooms server is busy. Try again in a moment.',
  unreachable: 'Cannot reach the rooms server.',
}
