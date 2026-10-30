// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import type { Task } from '@corral/contracts'
import { api } from '~/composables/useApi'
import type { InboxPanelContext } from './useInboxPanel'

// COR-190 v4: on a cold deep link the task can load before the live state
// has the projects. The PR detail and design versions must still load once
// the project's slug is known.
describe('Inbox panel loads', () => {
  const projects = ref<{ id: string, slug: string }[]>([])
  beforeEach(() => {
    projects.value = []
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useLive', () => ({ state: computed(() => ({ projects: projects.value })) }))
    vi.stubGlobal('useRouter', () => ({ resolve: (path: string) => ({ href: `#${path}` }) }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads the PR detail once the project slug arrives', async () => {
    const pullRequest = vi.spyOn(api.tasks, 'pullRequest').mockResolvedValue({ number: 64, url: 'u', title: 't', body: 'b', baseBranch: 'main', headBranch: 'h', files: [] })
    const { useInboxPanel } = await import('./useInboxPanel')
    const ctx = reactive({
      item: { id: 't-5', type: 'human_review', prUrl: 'https://github.com/o/r/pull/64', body: '', resolution: null, sender: { name: 'Rita', role: 'reviewer' }, project: {} },
      task: { id: 't-5', projectId: 'p-1', number: 5, type: 'task', acceptanceCriteria: [], latestReview: null, gateChecks: null } as unknown as Task,
      evidence: [], reviews: [], actions: [], alreadyResolved: false
    }) as unknown as InboxPanelContext
    const scope = effectScope()
    const p = scope.run(() => useInboxPanel(ctx))!
    await nextTick()
    expect(pullRequest).not.toHaveBeenCalled()
    projects.value = [{ id: 'p-1', slug: 'corral' }]
    await nextTick()
    await nextTick()
    expect(pullRequest).toHaveBeenCalledWith('corral', 5)
    expect(p.prDetail.value?.number).toBe(64)
    scope.stop()
  })
})
