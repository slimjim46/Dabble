import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// /admin is a separate page with its own Supabase session (6.5), so its code
// is split out of the main drawing bundle.
const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))

// App-shell service worker (PWA). Registered from here rather than from an
// inline script in index.html, so the document has no script outside <body>.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

const isAdminRoute = window.location.pathname.startsWith('/admin')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdminRoute ? (
      <Suspense fallback={<div className="admin-loading">Loading…</div>}>
        <AdminApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
)
