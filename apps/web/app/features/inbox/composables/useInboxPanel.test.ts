// @vitest-environment happy-dom
import type { PullRequestDetail, ServerEvent, Task } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { useInboxPanel, type InboxPanelContext } from '~/features/inbox/composables/useInboxPanel'
import { inbox, pullRequestDetails, tasks } from '~/prototype/fixtures'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { testQueryClient } from '~/queries/mount-with-query'

vi.mock('~/composables/useApi', () => ({ api: { projects: { pullRequest: vi.fn() }, tasks: { designs: vi.fn() } } }))

const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
})

const review = () => inbox().needsYou.find(i => i.type === 'human_review' && i.taskRef === 'COR-5')!
const pr = () => structuredClone(pullRequestDetails[0]!) as PullRequestDetail

async function mountPanel({ item = review() as InboxPanelContext['item'], task = (t: Task) => t as Task | null, alreadyResolved = false } = {}) {
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('useRouter', () => ({ resolve: (path: string) => ({ href: path }) }))
  vi.mocked(api.tasks.designs).mockResolvedValue([])
  const ctx = vue.reactive({
    item, alreadyResolved, evidence: [], reviews: [],
    task: item.taskRef ? task(structuredClone(tasks.find(t => t.ref === item.taskRef)!)) : null
  }) as unknown as InboxPanelContext
  const client = testQueryClient()
  let panel!: ReturnType<typeof useInboxPanel>
  wrappers.push(mount(vue.defineComponent({
    setup() {
      panel = useInboxPanel(ctx)
      return () => null
    }
  }), { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } }))
  await flushPromises()
  const emitLive = async (event: unknown) => {
    await invalidateKeys(client, applyEvent(client, event as ServerEvent))
    await flushPromises()
  }
  return { panel, emitLive }
}

describe('the PR of an Inbox item', () => {
  it('loads a code review\'s PR', async () => {
    vi.mocked(api.projects.pullRequest).mockResolvedValue(pr())
    const { panel } = await mountPanel()
    expect(api.projects.pullRequest).toHaveBeenCalledExactlyOnceWith('corral', 64)
    expect(panel.hasPullRequest.value).toBe(true)
    expect(panel.prDetail.value?.totalFiles).toBe(pr().totalFiles)
  })

  it.each(['design', 'spike'] as const)('has none for a %s, even with a PR', async (type) => {
    const { panel } = await mountPanel({ task: t => ({ ...t, type }) })
    expect(panel.hasPullRequest.value).toBe(false)
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
  })

  it('has none for an item without a PR', async () => {
    const item = inbox().needsYou.find(i => i.type === 'failed' && i.taskRef && !i.prUrl)! as InboxPanelContext['item']
    const { panel } = await mountPanel({ item })
    expect(panel.hasPullRequest.value).toBe(false)
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
  })

  it('reports a PR that failed to load, and Retry goes back through loading', async () => {
    vi.mocked(api.projects.pullRequest).mockRejectedValue(new Error('Runner offline'))
    const { panel } = await mountPanel()
    expect(panel.prFailed.value).toBe(true)
    expect(panel.prError.value).toBe('Runner offline')
    let finish!: () => void
    vi.mocked(api.projects.pullRequest).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve(pr())
    }))
    panel.retryPullRequest()
    await flushPromises()
    expect(panel.prLoading.value).toBe(true)
    finish()
    await flushPromises()
    expect(panel.prFailed.value).toBe(false)
    expect(panel.prDetail.value?.number).toBe(64)
  })

  it('refetches the PR when a run on its task ends, not while one is going', async () => {
    vi.mocked(api.projects.pullRequest).mockResolvedValue(pr())
    const { panel, emitLive } = await mountPanel()
    const run = { id: 'r-1', agentId: 'a-1', projectId: 'p-corral', taskRef: 'COR-5', endedAt: null }
    vi.mocked(api.projects.pullRequest).mockClear()
    await emitLive({ type: 'run.updated', run })
    await emitLive({ type: 'run.updated', run: { ...run, taskRef: 'COR-6', endedAt: '2026-11-01T00:00:00.000Z' } })
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
    vi.mocked(api.projects.pullRequest).mockResolvedValue({ ...pr(), totalFiles: 9 })
    await emitLive({ type: 'run.updated', run: { ...run, endedAt: '2026-11-01T00:00:00.000Z' } })
    expect(api.projects.pullRequest).toHaveBeenCalledOnce()
    expect(panel.prDetail.value?.totalFiles).toBe(9)
  })
})

describe('acting on an Inbox item', () => {
  it('is offered on an open item', async () => {
    vi.mocked(api.projects.pullRequest).mockResolvedValue(pr())
    expect((await mountPanel()).panel.canAct.value).toBe(true)
  })

  it('is not offered on a resolved item, which says how it was resolved', async () => {
    const resolved = inbox().resolved.find(i => i.taskId)! as InboxPanelContext['item']
    const { panel } = await mountPanel({ item: resolved })
    expect(panel.canAct.value).toBe(false)
    expect(panel.readOnlyNote.value).toBe(resolved.resolution)
  })

  it('is not offered on an item resolved elsewhere', async () => {
    vi.mocked(api.projects.pullRequest).mockResolvedValue(pr())
    expect((await mountPanel({ alreadyResolved: true })).panel.canAct.value).toBe(false)
  })
})
