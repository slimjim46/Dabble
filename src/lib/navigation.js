export function currentPath() {
  return window.location.pathname
}

export function navigate(to) {
  window.history.pushState({}, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function subscribeToPath(listener) {
  window.addEventListener('popstate', listener)
  return () => window.removeEventListener('popstate', listener)
}
