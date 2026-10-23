import React, { Suspense, lazy, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { currentPath, subscribeToPath } from './lib/navigation.js'
import { DAILY_GALLERY_PATH, DAILY_PATH, dailyView } from './daily/dailyRoute.js'
import './index.css'

// /admin is a separate page with its own Supabase session (6.5), so its code
// is split out of the main drawing bundle. /rooms and /r/<code> are the same
// story: the room client ships in its own chunk and never loads for a plaza
// visitor.
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))
const RoomsApp = lazy(() => import('./rooms/RoomsApp.jsx'))
const DailyApp = lazy(() => import('./daily/DailyApp.jsx'))
const DailyGalleryApp = lazy(() => import('./daily/DailyGallery.jsx'))

// App-shell service worker (PWA). Registered from here rather than from an
// inline script in index.html, so the document has no script outside <body>.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

function Root() {
  const pathname = useSyncExternalStore(subscribeToPath, currentPath)
  const isAdminRoute = pathname.startsWith('/admin')
  const isRoomsRoute = pathname === '/rooms' || pathname.startsWith('/rooms/') || pathname.startsWith('/r/')
  const isDailyRoute = pathname === DAILY_PATH || pathname === DAILY_GALLERY_PATH

  return (
    <React.StrictMode>
      {isAdminRoute ? (
        <Suspense fallback={<div className="admin-loading">Loading…</div>}>
          <AdminApp />
        </Suspense>
      ) : isDailyRoute ? (
        <Suspense fallback={<div className="admin-loading">Loading…</div>}>
          {dailyView(pathname) === 'gallery' ? <DailyGalleryApp /> : <DailyApp />}
        </Suspense>
      ) : isRoomsRoute ? (
        <Suspense fallback={<div className="admin-loading">Loading…</div>}>
          <RoomsApp />
        </Suspense>
      ) : (
        <App />
      )}
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />)
