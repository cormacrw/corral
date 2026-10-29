import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Runs the real public/sw.js in a sandbox standing in for the worker's
// global scope, then sends it fetch events
const ORIGIN = 'https://corral.example.com'
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')

function loadWorker() {
  const listeners: Record<string, (event: unknown) => void> = {}
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}), add: vi.fn(async () => {}) }
  const fetch = vi.fn(async () => new Response('ok'))
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    }
  }
  runInNewContext(source, {
    self,
    fetch,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    URL,
    Response
  })

  function send(url: string, init: { method?: string, mode?: string, headers?: Record<string, string> } = {}) {
    const respondWith = vi.fn()
    const request = { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: new Headers(init.headers) }
    listeners.fetch!({ request, respondWith })
    return respondWith.mock.calls.length > 0
  }
  return { send }
}

describe('service worker', () => {
  it('never handles /api/**, so data always comes live from the server', () => {
    const worker = loadWorker()
    expect(worker.send(`${ORIGIN}/api/tasks`)).toBe(false)
    expect(worker.send(`${ORIGIN}/api/projects/corral/tasks?status=ready`)).toBe(false)
    expect(worker.send(`${ORIGIN}/api`)).toBe(false)
    expect(worker.send(`${ORIGIN}/api/attachments/1`, { mode: 'navigate' })).toBe(false)
    expect(worker.send(`${ORIGIN}/api/tasks`, { method: 'POST' })).toBe(false)
  })

  it('never handles live connections', () => {
    const worker = loadWorker()
    expect(worker.send(`${ORIGIN}/api/events`, { headers: { accept: 'text/event-stream' } })).toBe(false)
    expect(worker.send(`${ORIGIN}/live`, { headers: { accept: 'text/event-stream' } })).toBe(false)
    expect(worker.send(`${ORIGIN}/socket`, { headers: { upgrade: 'websocket' } })).toBe(false)
  })

  it('leaves other origins and writes alone', () => {
    const worker = loadWorker()
    expect(worker.send('https://example.cloudflareaccess.com/cdn-cgi/access/login')).toBe(false)
    expect(worker.send(`${ORIGIN}/tasks/COR-1`, { method: 'POST', mode: 'navigate' })).toBe(false)
  })

  it('serves the app shell: pages, hashed build files and icons', () => {
    const worker = loadWorker()
    expect(worker.send(`${ORIGIN}/tasks/COR-1`, { mode: 'navigate' })).toBe(true)
    expect(worker.send(`${ORIGIN}/_nuxt/entry.Bx1c2d.js`)).toBe(true)
    expect(worker.send(`${ORIGIN}/icon-192.png`)).toBe(true)
    expect(worker.send(`${ORIGIN}/manifest.webmanifest`)).toBe(true)
  })

  it('keeps Nuxt\'s unhashed build manifest and other files out of the cache', () => {
    const worker = loadWorker()
    expect(worker.send(`${ORIGIN}/_nuxt/builds/latest.json`)).toBe(false)
    expect(worker.send(`${ORIGIN}/some/other.txt`)).toBe(false)
  })
})
