// Corral's service worker (D17, design/mobile.md). It caches the built app
// shell only, so the installed app opens fast. All data is live from
// apps/server: /api/** (the /api/events stream included) and any other live
// connection always go straight to the network and are never cached.
// plugins/pwa.client.ts registers it in production builds only.
const CACHE = 'corral-shell-v1'

// Fetched when the worker installs. Paths are relative to the origin, since
// Corral runs behind whatever hostname the tunnel gives it (D12).
const SHELL = ['/', '/manifest.webmanifest', '/favicon.ico', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']

// How a request is served: 'page' (network first, falling back to the cached
// shell), 'asset' (a content-hashed build file: cache first), 'shell' (a
// static shell file: network first, falling back to the cache), or null to
// leave it to the browser.
function strategyFor(request, origin) {
  if (request.method !== 'GET') return null
  const url = new URL(request.url)
  if (url.origin !== origin) return null
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null
  // Live connections: server-sent events and WebSocket upgrades
  if ((request.headers.get('accept') ?? '').includes('text/event-stream')) return null
  if (request.headers.get('upgrade')) return null
  if (request.mode === 'navigate') return 'page'
  // Nuxt's build manifest isn't content-hashed, so it must stay fresh
  if (url.pathname.startsWith('/_nuxt/builds/')) return null
  if (url.pathname.startsWith('/_nuxt/')) return 'asset'
  if (SHELL.includes(url.pathname)) return 'shell'
  return null
}

// Only plain successful responses: a Cloudflare Access sign-in redirect or an
// error page must never stand in for the app
function cacheable(response) {
  return response.ok && response.type === 'basic' && !response.redirected
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (cacheable(response)) await cache.put(key, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(key)
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (cacheable(response)) await cache.put(request, response.clone())
  return response
}

self.addEventListener('install', (event) => {
  // One missing file (or a sign-in redirect) shouldn't stop the install
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.allSettled(SHELL.map(path => cache.add(path))))
    .then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const strategy = strategyFor(event.request, self.location.origin)
  if (!strategy) return
  if (strategy === 'page') {
    // Every route is the same single-page shell (ssr: false)
    event.respondWith(networkFirst(event.request, '/'))
  } else if (strategy === 'asset') {
    event.respondWith(cacheFirst(event.request))
  } else {
    event.respondWith(networkFirst(event.request, event.request))
  }
})
