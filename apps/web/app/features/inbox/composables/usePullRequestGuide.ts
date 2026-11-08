import { useMutation, useQuery } from '@tanstack/vue-query'
import type { PullRequestDetail, PullRequestGuide, Task } from '@corral/contracts'
import { useLocalStorage } from '@vueuse/core'
import { generatePullRequestGuide, pullRequestGuideQuery } from '~/queries/tasks'
import { guideSteps } from '~/features/inbox/utils/guide'

// A PR's guided review (COR-525): read it, ask for it, and remember which steps this browser has read. Read marks are kept per head
// commit, so a new push starts them over; they never gate Approve.
export function usePullRequestGuide(slug: string, taskRef: string, pr: () => PullRequestDetail, criteria: () => Task['acceptanceCriteria']) {
  const query = useQuery(computed(() => pullRequestGuideQuery({ slug, ref: taskRef }, pr().number)))
  const generate = useMutation(generatePullRequestGuide)
  const guide = computed(() => query.data.value ?? null)
  const status = computed<PullRequestGuide['status'] | 'loading'>(() => generate.isPending.value ? 'generating' : guide.value?.status ?? 'loading')
  const error = computed(() => generate.error.value?.message ?? guide.value?.error ?? (query.isError.value ? 'The guide didn\'t load.' : null))
  const failed = computed(() => status.value === 'failed' || (!generate.isPending.value && (generate.isError.value || query.isError.value)))
  const steps = computed(() => guide.value?.status === 'ready' ? guideSteps(pr(), guide.value, criteria()) : [])
  // Made for a commit the PR has moved on from; only the reader regenerates it
  const stale = computed(() => guide.value?.status === 'ready' && !!guide.value.headSha && guide.value.headSha !== pr().headSha)

  const read = useLocalStorage<string[]>(computed(() => `corral:guide-read:${taskRef}:${pr().headSha}`), [])
  const isRead = (id: string) => read.value.includes(id)
  const setRead = (id: string, value: boolean) => {
    read.value = value ? [...new Set([...read.value, id])] : read.value.filter(x => x !== id)
  }
  const readCount = computed(() => steps.value.filter(s => isRead(s.id)).length)
  return { guide, status, error, failed, steps, stale, generate: () => generate.mutate({ slug, ref: taskRef, number: pr().number }), isRead, setRead, readCount }
}
export type PullRequestGuideState = ReturnType<typeof usePullRequestGuide>
