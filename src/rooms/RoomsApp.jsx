import { useCallback, useEffect, useState } from 'react'
import { ROOM_CODE_RE } from './roomsConfig.js'
import RoomScreen from './RoomScreen.jsx'
import RoomsHome from './RoomsHome.jsx'
import './rooms.css'

const ROOM_PATH = /^\/r\/([^/]+)\/?$/

/**
 * `/rooms` to create or join, `/r/ABCDE` to draw. Routing is a pathname read
 * plus pushState rather than a router: two routes and a back button do not
 * justify a dependency, and the plaza at `/` keeps its own entry point
 * untouched.
 */
function readRoute() {
  const match = ROOM_PATH.exec(window.location.pathname)
  if (match) {
    const code = match[1].toUpperCase()
    if (ROOM_CODE_RE.test(code)) return { name: 'room', code }
  }
  return { name: 'home', code: null }
}

export default function RoomsApp() {
  const [route, setRoute] = useState(readRoute)
  const roomsUrl = import.meta.env.VITE_ROOMS_URL ?? ''

  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const previous = document.title
    document.title = route.name === 'room' ? `DoodleScrap · ${route.code}` : 'DoodleScrap Rooms'
    return () => {
      document.title = previous
    }
  }, [route])

  const navigate = useCallback((to) => {
    window.history.pushState({}, '', to)
    setRoute(readRoute())
  }, [])

  if (!roomsUrl) {
    return (
      <div className="rooms-home">
        <div className="rooms-card">
          <h1 className="rooms-title">Rooms are not configured</h1>
          <p className="rooms-sub">
            This deployment has no <code>VITE_ROOMS_URL</code>, so it cannot reach the room server.
          </p>
        </div>
      </div>
    )
  }

  if (route.name === 'room') {
    return (
      <RoomScreen key={route.code} roomsUrl={roomsUrl} code={route.code} onLeave={() => navigate('/rooms')} />
    )
  }

  return <RoomsHome roomsUrl={roomsUrl} onJoin={(code) => navigate(`/r/${code}`)} />
}
