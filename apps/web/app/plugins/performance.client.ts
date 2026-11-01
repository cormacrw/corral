import { PAGE_PATTERNS, type ClientPerfSample } from '@corral/contracts'
import { onCLS, onINP, onLCP } from 'web-vitals'

export default defineNuxtPlugin((app) => {
  if (import.meta.prototype) return

  const router = useRouter()
  const sessionId = crypto.randomUUID()
  const pending: ClientPerfSample[] = []
  const pattern = () => {
    const path = router.currentRoute.value.matched.at(-1)?.path
      .replace(/:([\w]+)(?:\([^)]*\))?([?*+]?)/g, (_match, name: string, optional: string) =>
        optional === '?' || optional === '*' ? `[[${name}]]` : `[${name}]`)
    return PAGE_PATTERNS.find(candidate => candidate === path)
  }
  const record = (name: ClientPerfSample['name'] | undefined, metric: ClientPerfSample['metric'], value: number) => {
    if (name && Number.isFinite(value) && value >= 0 && value <= 86_400_000) {
      // Bounded even if the browser refuses beacons for a long time.
      if (pending.length >= 50) pending.shift()
      pending.push({ name, metric, value })
    }
  }
  const flush = () => {
    if (!pending.length) return
    try {
      if (navigator.sendBeacon('/api/perf/client', new Blob([
        JSON.stringify({ sessionId, samples: pending })
      ], { type: 'application/json' }))) pending.length = 0
    } catch { /* Diagnostics must never interrupt navigation. */ }
  }

  let start = 0
  let begun = 0
  let initial = true
  let initialPattern: ClientPerfSample['name'] | undefined
  router.beforeEach(() => {
    begun = performance.now()
  })
  // Armed only once the navigation is confirmed: Nuxt also fires
  // page:loading:end for failed navigations, before this hook and after errors.
  router.afterEach((_to, _from, failure) => {
    start = failure ? -1 : begun
  })
  // page:finish needs a Suspense, which a page keeping its key skips.
  // page:loading:end covers both, and the guard keeps it to one sample.
  app.hook('page:loading:end', () => {
    if (start < 0) return
    const name = pattern()
    if (initial) initialPattern = name
    record(name, 'navigation', performance.now() - (initial ? 0 : start))
    initial = false
    start = -1
  })

  const navigationTiming = () => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (!entry) return
    // The load event's end timestamp is populated after its listeners return.
    record(initialPattern ?? pattern(), 'ttfb', entry.responseStart - entry.startTime)
    record(initialPattern ?? pattern(), 'domReady', entry.domContentLoadedEventEnd - entry.startTime)
    record(initialPattern ?? pattern(), 'load', entry.loadEventEnd - entry.startTime)
  }
  if (document.readyState === 'complete') setTimeout(navigationTiming, 0)
  else window.addEventListener('load', () => setTimeout(navigationTiming, 0), { once: true })

  // Vitals describe the document session, attributed to its landing route.
  // The library handles buffered entries, CLS session windows and INP's percentile.
  const vital = (metric: { name: 'LCP' | 'INP' | 'CLS', value: number }) => {
    // Keep the latest value within a batch as document metrics evolve.
    const previous = pending.findIndex(sample => sample.metric === metric.name)
    if (previous !== -1) pending.splice(previous, 1)
    record(initialPattern ?? pattern(), metric.name, metric.value)
  }
  onLCP(vital, { reportAllChanges: true })
  onINP(vital, { reportAllChanges: true })
  onCLS(vital, { reportAllChanges: true })
  setInterval(flush, 5000)
  // Registered after web-vitals so its final values join this beacon.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
})
