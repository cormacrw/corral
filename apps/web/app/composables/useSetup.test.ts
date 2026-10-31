// @vitest-environment happy-dom
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError, api } from './useApi'
import { useSetup } from './useSetup'
import { mountWithQuery } from '../queries/mount-with-query'
import { suggestPrefix } from '../utils/prefix'

vi.mock('./useApi', async original => ({ ...await original<typeof import('./useApi')>(), api: {
  setup: { repos: vi.fn(), checkRepo: vi.fn(), clis: vi.fn() },
  projects: { list: vi.fn(), create: vi.fn() }
} }))
const push = vi.fn()
const toast = vi.fn()
let adding = true
beforeEach(() => {
  vi.clearAllMocks()
  adding = true
  for (const [name, value] of Object.entries({ ref, computed, reactive, watch, onMounted: () => {},
    useRoute: () => ({ query: adding ? { add: '1' } : {} }),
    useRouter: () => ({ replace: vi.fn(), push }),
    useToast: () => ({ add: toast })
  })) vi.stubGlobal(name, value)
  vi.mocked(api.projects.list).mockResolvedValue([{ prefix: 'COR' }] as never)
  vi.mocked(api.setup.checkRepo).mockResolvedValue({ ready: true } as never)
  vi.mocked(api.setup.repos).mockResolvedValue({ signedIn: true, repos: [] } as never)
  vi.mocked(api.setup.clis).mockResolvedValue([{ id: 'claude', signedIn: true }] as never)
})

function mountSetup() {
  let setup!: ReturnType<typeof useSetup>
  mountWithQuery(defineComponent({ setup() {
    setup = useSetup()
    return () => h('div')
  } }))
  return setup
}

it('suggests a free valid prefix for collisions, short and non-letter names', () => {
  expect(suggestPrefix('corral', ['COR'])).toBe('CORR')
  for (const name of ['a', '123', 'ab', 'corral']) {
    const used = [suggestPrefix(name, [])]
    expect(suggestPrefix(name, used)).toMatch(/^[A-Z]{2,5}$/)
    expect(used).not.toContain(suggestPrefix(name, used))
  }
})
it('normalizes edits, blocks invalid submissions and creates with the edited prefix', async () => {
  const setup = mountSetup()
  await setup.pick('cormacrw/test-app')
  expect(setup.prefix.value).toBe('TES')
  for (const value of ['a1-', 'abcdef']) {
    setup.setPrefix(value)
    expect(setup.prefixError.value).toBe('Use 2–5 letters, A–Z.')
    expect(setup.canContinue.value).toBe(false)
    await setup.next()
    expect(api.projects.create).not.toHaveBeenCalled()
  }
  setup.setPrefix('ta-9m')
  expect(setup.prefix.value).toBe('TAM')
  vi.mocked(api.projects.create).mockResolvedValue({ slug: 'test-app' } as never)
  await setup.next()
  expect(api.projects.create).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'TAM' }))
  expect(push).toHaveBeenCalledWith('/projects/test-app')
})
it.each([true, false])('keeps conflicts editable on the repository step (adding=%s)', async (add) => {
  adding = add
  const setup = mountSetup()
  await setup.pick('cormacrw/test-app')
  setup.setPrefix('COR')
  setup.step.value = add ? 'repo' : 'names'
  vi.mocked(api.projects.create).mockRejectedValue(new ApiError(409, { code: 'conflict', constraint: 'projects_prefix_unique' }, 'Conflict'))
  await setup.next()
  expect(setup.step.value).toBe('repo')
  expect(setup.prefixError.value).toBe('Another project uses this prefix.')
  expect(push).not.toHaveBeenCalled()
  expect(toast).not.toHaveBeenCalled()
  setup.setPrefix('NEW')
  expect(setup.prefixError.value).toBeUndefined()
  expect(setup.canContinue.value).toBe(true)
})
it('ignores an earlier repository check that completes after another selection', async () => {
  let resolveFirst!: (value: never) => void
  vi.mocked(api.setup.checkRepo).mockImplementationOnce(() => new Promise((resolve) => {
    resolveFirst = resolve
  }))
  const setup = mountSetup()
  const first = setup.pick('owner/corral')
  await setup.pick('cormacrw/test-app')
  resolveFirst({ ready: true } as never)
  await first
  expect(setup.prefix.value).toBe('TES')
  expect(setup.picked.value?.nameWithOwner).toBe('cormacrw/test-app')
})
it('loads each step\'s list as it opens, and Refresh replaces that list', async () => {
  adding = false
  const setup = mountSetup()
  expect(api.setup.repos).not.toHaveBeenCalled()
  setup.step.value = 'repo'
  await vi.waitFor(() => expect(setup.repos.value).toEqual({ signedIn: true, repos: [] }))
  vi.mocked(api.setup.repos).mockRejectedValueOnce(new Error('GitHub is down'))
  await setup.loadRepos()
  expect(setup.reposError.value).toBe('GitHub is down')
  vi.mocked(api.setup.repos).mockResolvedValueOnce({ signedIn: false } as never)
  await setup.loadRepos()
  expect(api.setup.repos).toHaveBeenLastCalledWith(true)
  expect(setup.reposError.value).toBeNull()
  expect(setup.repos.value).toEqual({ signedIn: false })
  expect(api.setup.clis).not.toHaveBeenCalled()
  setup.step.value = 'agents'
  await vi.waitFor(() => expect(setup.clis.value).toHaveLength(1))
})
