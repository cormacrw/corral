import type { PullRequestStatus } from '@corral/contracts'
import { useQuery } from '@tanstack/vue-query'
import type { Cell } from '~/features/projects/utils/pull-requests'
import { ciCell, evidenceCell, mergeCell, rebaseCell, reviewCell } from '~/features/projects/utils/pull-requests'
import { pullRequestsQuery } from '~/queries/projects'

export interface PullRequestRow {
  pr: PullRequestStatus
  // Review, CI, Rebase and Evidence, in column order
  cells: (Cell & { term: string })[]
  merge: Cell
}

const pullRequestRow = (pr: PullRequestStatus): PullRequestRow => ({
  pr,
  cells: [
    { term: 'Review', ...reviewCell(pr) },
    { term: 'CI', ...ciCell(pr) },
    { term: 'Rebase', ...rebaseCell(pr) },
    { term: 'Evidence', ...evidenceCell(pr) }
  ],
  merge: mergeCell(pr)
})

export function usePullRequests() {
  const { slug, project } = useProject()
  // The parent prefetches once. Mounting this tab shows that cache immediately;
  // polling and task/run event refetches run only while this page is mounted.
  const { data: prs, error, refetch } = useQuery(computed(() => ({
    ...pullRequestsQuery(slug.value), enabled: Boolean(project.value), refetchOnMount: false
  })))
  // Spins for the button only, not for each poll behind it
  const refreshing = ref(false)
  async function refresh() {
    refreshing.value = true
    await refetch()
    refreshing.value = false
  }
  const rows = computed(() => (prs.value ?? []).map(pullRequestRow))
  const summary = computed(() => {
    const list = prs.value ?? []
    const eligible = list.filter(pr => pr.merge.eligible && !pr.humanReviewOutstanding).length
    return `${list.length} open ${list.length === 1 ? 'PR' : 'PRs'} · ${eligible} eligible to merge`
  })
  return { prs, rows, summary, error, refetch, refreshing, refresh }
}
