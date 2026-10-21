// App-shell service worker (PWA).
//
// Rules, in order:
//  - another origin is never touched: Supabase, Cloudflare and friends pass
//    straight through to the network and are never cached.
//  - /api/* is never cached: those responses are short-lived server output
//    (including the snapshot redirect), not static assets.
//  - navigations are network-first, and the cache is only the offline
//    fallback, so a deploy is visible on the next load.
//  - only Vite's hashed /assets/* is cache-first: those names are content
//    addressed, so the bytes behind a given URL can never change.
const CACHE = 'doodlescrap-shell-v2'
const SHELL_URL = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', SHELL_URL])).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      await dropStaleAssets()
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // cross-origin: not ours to cache
  if (url.pathname.startsWith('/api/')) return // server responses: never cached

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstDocument(req))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(req))
    return
  }
  // Icons, the manifest, sw.js itself: plain network, nothing stored.
})

/** Navigation: the network is the truth, the cache is only for being offline. */
async function networkFirstDocument(req) {
  try {
    const res = await fetch(req)
    if (res && res.ok) {
      // Whatever the path, the document it returned is the app shell.
      const cache = await caches.open(CACHE)
      await cache.put(SHELL_URL, res.clone())
    }
    return res
  } catch {
    const cache = await caches.open(CACHE)
    const cached = (await cache.match(SHELL_URL)) ?? (await cache.match('/'))
    if (cached) return cached
    throw new Error('offline and no cached shell')
  }
}

/** Hashed bundle files: the URL already tells us the bytes cannot change. */
async function cacheFirstAsset(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req)
  if (cached) return cached

  const res = await fetch(req)
  if (res && res.ok && res.type === 'basic') {
    await cache.put(req, res.clone())
  }
  return res
}

/**
 * Hashed bundles from older deploys can never be requested again, but they
 * would sit in the cache forever. Anything under /assets/ that the shell we
 * cached at install time does not reference is from an older deploy and goes.
 * A parse that finds nothing is treated as a failure: dropping every asset
 * because the HTML looked unexpected would take the whole app offline.
 */
async function dropStaleAssets() {
  try {
    const cache = await caches.open(CACHE)
    const res = (await cache.match(SHELL_URL)) ?? (await cache.match('/'))
    if (!res) return
    const html = await res.text()
    const keep = new Set()
    for (const match of html.matchAll(/\/assets\/[\w.-]+/g)) keep.add(match[0])
    if (keep.size === 0) return

    const requests = await cache.keys()
    await Promise.all(
      requests
        .filter((req) => {
          const path = new URL(req.url).pathname
          return path.startsWith('/assets/') && !keep.has(path)
        })
        .map((req) => cache.delete(req)),
    )
  } catch {
    // The shell could not be read: keeping old assets is the safe answer.
  }
}
