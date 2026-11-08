import { describe, expect, it } from 'vitest'
import type { AppDeps } from './app.ts'
import { checkPmRouteCoverage, pmRouteExclusions, pmRouteTools } from './pm-route-coverage.ts'
import { createServerApp } from './server.ts'

// Registration is synchronous and does not touch dependencies. Refuse any
// accidental service access instead of starting a DB, runner or listener.
function registeredApp() {
  const deps = new Proxy({} as AppDeps, {
    get() { throw new Error('Route enumeration must not access services') }
  })
  // createApp destructures deps at registration, but handlers alone use them.
  const inert = Object.fromEntries([
    'db', 'events', 'actor', 'runner', 'orchestrator', 'blobs', 'transcripts', 'plans', 'releaseNotes'
  ].map(key => [key, deps])) as unknown as AppDeps
  return createServerApp(inert).app
}

describe('PM API route coverage', () => {
  it('covers every route on the actual server, including WebSocket and middleware', () => {
    const app = registeredApp()
    expect(app.routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/runner' }))
    expect(() => checkPmRouteCoverage(app.routes)).not.toThrow()
  })

  it('names a newly registered route that has no PM tool or exclusion', () => {
    const app = registeredApp()
    app.post('/api/uncovered-example', c => c.json({ ok: true }))
    expect(() => checkPmRouteCoverage(app.routes)).toThrow('POST /api/uncovered-example')
  })

  it('rejects an unknown tool, naming it and its route', () => {
    expect(() => checkPmRouteCoverage(registeredApp().routes, {
      ...pmRouteTools, 'GET /api/projects': ['imaginary_pm_tool']
    })).toThrow(/GET \/api\/projects.*imaginary_pm_tool/)
  })

  it('requires a written reason on every exclusion', () => {
    expect(() => checkPmRouteCoverage(registeredApp().routes, pmRouteTools, {
      ...pmRouteExclusions, 'GET /api/health': '  '
    })).toThrow('GET /api/health')
  })

  it('rejects empty mappings, overlaps and stale entries', () => {
    expect(() => checkPmRouteCoverage(registeredApp().routes, {
      ...pmRouteTools, 'GET /api/health': [], 'GET /api/removed': ['get_task']
    })).toThrow('GET /api/removed: mapped route is not registered')
    expect(() => checkPmRouteCoverage(registeredApp().routes, {
      ...pmRouteTools, 'GET /api/health': []
    })).toThrow('GET /api/health: map at least one existing PM tool')
    expect(() => checkPmRouteCoverage(registeredApp().routes, {
      ...pmRouteTools, 'GET /api/health': ['get_status']
    })).toThrow('GET /api/health: choose either')
    expect(() => checkPmRouteCoverage(registeredApp().routes, pmRouteTools, {
      ...pmRouteExclusions, 'GET /api/removed': 'Removed endpoint'
    })).toThrow('GET /api/removed: excluded route is not registered')
  })
})
