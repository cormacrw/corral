import type { RouteLocationNormalized } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

// The middleware with Nuxt's auto-imports stubbed: a fresh browser (nothing
// cached, nothing in storage) and the server's project list
const client = testQueryClient()
vi.mock('@tanstack/vue-query', async original => ({ ...await original<typeof import('@tanstack/vue-query')>(), useQueryClient: () => client }))
let projects: unknown = []
let reachable = true
const mode = { value: 'web' as 'web' | 'mobile' }
vi.stubGlobal('useDevice', () => ({ mode }))

vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn)
vi.stubGlobal('navigateTo', (to: string) => ({ redirect: to }))

const { default: middleware } = await import('./setup.global.ts') as unknown as {
  default: (to: Pick<RouteLocationNormalized, 'path' | 'query'>) => Promise<{ redirect: string } | undefined>
}
const visit = (path: string, query: Record<string, string> = {}) => middleware({ path, query })

beforeEach(() => {
  client.clear()
  reachable = true
  mode.value = 'web'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!reachable) throw new TypeError('Failed to fetch')
    expect(url).toBe('/api/projects')
    return new Response(JSON.stringify(projects), { status: 200 })
  }))
  vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() })
})

afterEach(() => {
  // Onboarding status never comes from the browser
  expect(localStorage.getItem).not.toHaveBeenCalled()
  expect(localStorage.setItem).not.toHaveBeenCalled()
})

describe('setup middleware with a project on the server', () => {
  beforeEach(() => {
    projects = [{ slug: 'test-app' }]
  })

  it('opens Home immediately in mobile mode on a cold launch', async () => {
    mode.value = 'mobile'
    expect(await visit('/')).toEqual({ redirect: '/home' })
    expect(await visit('/setup')).toEqual({ redirect: '/home' })
    expect(await visit('/setup', { add: '1' })).toBeUndefined()
  })

  it('opens the project from / in a fresh browser', async () => {
    expect(await visit('/')).toEqual({ redirect: '/projects/test-app' })
  })

  it('redirects /setup and /setup?step=you away from the wizard', async () => {
    expect(await visit('/setup')).toEqual({ redirect: '/projects/test-app' })
    expect(await visit('/setup', { step: 'you' })).toEqual({ redirect: '/projects/test-app' })
  })

  it('still opens the add-project flow', async () => {
    expect(await visit('/setup', { step: 'repo', add: '1' })).toBeUndefined()
  })

  it('uses the cached list once there is one', async () => {
    client.setQueryData(keys.projects.list(), [{ slug: 'live' }])
    expect(await visit('/setup', { step: 'you' })).toEqual({ redirect: '/projects/live' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caches the list for the shell and asks only once', async () => {
    await visit('/')
    await visit('/home')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(keys.projects.list())).toEqual([{ slug: 'test-app' }])
  })
})

describe('setup middleware with no projects', () => {
  beforeEach(() => {
    projects = []
  })

  it('sends / to onboarding', async () => {
    for (const layout of ['web', 'mobile'] as const) {
      mode.value = layout
      expect(await visit('/')).toEqual({ redirect: '/setup' })
      expect(await visit('/setup', { add: '1' })).toBeUndefined()
    }
  })

  it('lets onboarding run to the end', async () => {
    for (const step of ['you', 'repo', 'agents', 'names']) expect(await visit('/setup', { step })).toBeUndefined()
  })
})

describe('setup middleware when the server cannot say', () => {
  it('sends nowhere when the request fails', async () => {
    reachable = false
    expect(await visit('/')).toBeUndefined()
    expect(await visit('/setup')).toBeUndefined()
    // One attempt each: a cold launch doesn't wait out query retries
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sends nowhere when the answer is not a project list', async () => {
    projects = null
    expect(await visit('/')).toBeUndefined()
    expect(client.getQueryData(keys.projects.list())).toBeUndefined()
  })
})
