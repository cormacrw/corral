import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { PullRequestDetail, PullRequestGuide, Task } from '@corral/contracts'
import { useLocalStorage } from '@vueuse/core'
import { api } from '~/composables/useApi'
import { keys } from '~/queries/keys'
import { guideSteps } from '~/features/inbox/utils/guide'

// A PR's guided review (COR-518, design): read it, ask for it, and remember
// which steps this browser has read, per head commit so a new push starts over.
export function usePullRequestGuide(slug: string, taskRef: string, pr: () => PullRequestDetail, criteria: () => Task['acceptanceCriteria']) {
  const client = useQueryClient()
  const key = computed(() => [...keys.tasks.pullRequest(taskRef, pr().number), 'guide'] as const)
  const query = useQuery(computed(() => ({
    queryKey: key.value,
    queryFn: () => api.projects.pullRequestGuide(slug, pr().number),
    // Generating takes seconds; poll until it ends
    refetchInterval: (q: { state: { data?: PullRequestGuide } }) => q.state.data?.status === 'generating' ? 1000 : false
  })))
  const generate = useMutation({
    mutationFn: () => api.projects.generatePullRequestGuide(slug, pr().number),
    onSuccess: guide => client.setQueryData(key.value, guide)
  })
  const guide = computed(() => query.data.value ?? null)
  const status = computed(() => generate.isPending.value ? 'generating' : guide.value?.status ?? 'loading')
  const steps = computed(() => guide.value?.status === 'ready' ? guideSteps(pr(), guide.value, criteria()) : [])

  const read = useLocalStorage<string[]>(computed(() => `corral:guide-read:${taskRef}:${guide.value?.headSha ?? ''}`), [])
  const isRead = (id: string) => read.value.includes(id)
  const setRead = (id: string, value: boolean) => {
    read.value = value ? [...new Set([...read.value, id])] : read.value.filter(x => x !== id)
  }
  const readCount = computed(() => steps.value.filter(s => isRead(s.id)).length)
  return { guide, status, steps, generate: () => generate.mutate(), isRead, setRead, readCount, loadFailed: computed(() => query.isError.value) }
}
export type PullRequestGuideState = ReturnType<typeof usePullRequestGuide>
