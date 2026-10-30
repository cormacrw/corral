import { queryOptions } from '@tanstack/vue-query'
import type { PatchProfileInput, Profile } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const profileQuery = () => queryOptions({ queryKey: keys.profile(), queryFn: () => api.me.get() })
export const runnerQuery = () => queryOptions({ queryKey: keys.runner(), queryFn: () => api.runner() })
export const statusQuery = () => queryOptions({ queryKey: keys.status(), queryFn: () => api.status() })

export const patchProfile = defineMutation<Profile, PatchProfileInput>({
  mutationFn: input => api.me.patch(input),
  invalidates: [keys.profile()]
})
