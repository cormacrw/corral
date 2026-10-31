// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('web-vitals', () => ({ onCLS: vi.fn(), onINP: vi.fn(), onLCP: vi.fn() }))

interface Guards {
  before: (() => void)[]
  after: ((to: unknown, from: unknown, failure?: unknown) => void)[]
}

// The hooks Nuxt calls, in the order its page and router runtime calls them
function harness() {
  const guards: Guards = { before: [], after: [] }
  const hooks = new Map<string, (() => void)[]>()
  const route = { value: { matched: [{ path: '/tasks/:ref' }] } }
  const call = (name: string) => hooks.get(name)?.forEach(hook => hook())
  vi.stubGlobal('useRouter', () => ({
    currentRoute: route,
    beforeEach: (guard: () => void) => guards.before.push(guard),
    afterEach: (guard: Guards['after'][number]) => guards.after.push(guard)
  }))
  const app = { hook: (name: string, hook: () => void) => hooks.set(name, [...hooks.get(name) ?? [], hook]) }
  return {
    app,
    route,
    call,
    begin: () => guards.before.forEach(guard => guard()),
    confirm: () => guards.after.forEach(guard => guard({}, {})),
    // Nuxt's own afterEach runs first and fires the hook for a failed navigation
    fail: () => {
      call('page:loading:end')
      guards.after.forEach(guard => guard({}, {}, new Error('aborted')))
    }
  }
}

async function navigationSamples(): Promise<{ name: string, value: number }[]> {
  window.dispatchEvent(new Event('pagehide'))
  const blobs = vi.mocked(navigator.sendBeacon).mock.calls.map(call => call[1] as Blob)
  const batches = await Promise.all(blobs.map(async blob => JSON.parse(await blob.text())))
  return batches.flatMap(batch => batch.samples).filter(sample => sample.metric === 'navigation')
}

async function start() {
  const page = harness()
  const { default: plugin } = await import('./performance.client')
  ;(plugin as unknown as (app: unknown) => void)(page.app)
  // The first paint, so each test below measures client navigation alone
  page.call('page:finish')
  page.call('page:loading:end')
  window.dispatchEvent(new Event('pagehide'))
  vi.mocked(navigator.sendBeacon).mockClear()
  return page
}

describe('navigation timing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn(() => true) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('records the first page once, from the start of the document', async () => {
    const page = harness()
    const { default: plugin } = await import('./performance.client')
    ;(plugin as unknown as (app: unknown) => void)(page.app)
    page.call('page:finish')
    page.call('page:loading:end')
    expect(await navigationSamples()).toHaveLength(1)
  })

  it('records one sample for a same-key navigation, where page:finish never fires', async () => {
    const page = await start()
    page.begin()
    vi.advanceTimersByTime(40)
    page.confirm()
    vi.advanceTimersByTime(10)
    page.call('page:loading:end')
    expect(await navigationSamples()).toEqual([expect.objectContaining({ name: '/tasks/[ref]', value: 50 })])
  })

  it('records one sample for a nested route that resolves two Suspense boundaries', async () => {
    const page = await start()
    page.route.value = { matched: [{ path: '/projects/:slug' }, { path: '/projects/:slug/board' }] }
    page.begin()
    page.confirm()
    page.call('page:finish')
    page.call('page:finish')
    page.call('page:loading:end')
    page.call('page:loading:end')
    expect(await navigationSamples()).toEqual([expect.objectContaining({ name: '/projects/[slug]/board' })])
  })

  it('records nothing for a failed navigation, even though Nuxt fires the hook', async () => {
    const page = await start()
    page.begin()
    page.fail()
    expect(await navigationSamples()).toEqual([])
  })

  it('records nothing when a guard throws and afterEach never runs', async () => {
    const page = await start()
    page.begin()
    page.call('page:loading:end')
    expect(await navigationSamples()).toEqual([])
  })
})
