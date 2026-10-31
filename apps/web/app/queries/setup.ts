import { queryOptions } from '@tanstack/vue-query'
import type { RepoList } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

// A login changes on the runner and no event says so, so every visit shows the
// last scan and scans again behind it
export const clisQuery = () => queryOptions({ queryKey: keys.setup.clis(), queryFn: () => api.setup.clis(), staleTime: 0 })
export const reposQuery = () => queryOptions({ queryKey: keys.setup.repos(), queryFn: () => api.setup.repos() })

// The server caches the list; this asks past that and is the same list
export const refreshRepos = defineMutation<RepoList>({
  mutationFn: () => api.setup.repos(true),
  write: (client, repos) => client.setQueryData(keys.setup.repos(), repos),
  invalidates: []
})
