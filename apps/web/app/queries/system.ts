import { queryOptions } from '@tanstack/vue-query'
import type { GlobalStatus, PatchProfileInput, Profile } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { defineMutation } from './dependencies'
import { keys } from './keys'

export const profileQuery = () => queryOptions({ queryKey: keys.profile(), queryFn: () => api.me.get() })
export const runnerQuery = () => queryOptions({ queryKey: keys.runner(), queryFn: () => api.runner() })
export const statusQuery = () => queryOptions({ queryKey: keys.status(), queryFn: () => api.status() })

export const stopAll = defineMutation<GlobalStatus>({
  mutationFn: () => api.stopAll(),
  invalidates: [keys.status()]
})
export const resumeAll = defineMutation<GlobalStatus>({
  mutationFn: () => api.resumeAll(),
  invalidates: [keys.status()]
})
export const liftUpdateHold = defineMutation<unknown>({
  mutationFn: () => api.liftUpdateHold(),
  invalidates: [keys.status()]
})
export const updateRunner = defineMutation<unknown, string>({
  mutationFn: id => api.updateRunner(id),
  invalidates: [keys.runner()]
})
export const setProfileAvatar = defineMutation<Profile, Blob | null>({
  mutationFn: image => image ? api.me.setAvatar(image) : api.me.clearAvatar(),
  invalidates: [keys.profile()]
})
export const patchProfile = defineMutation<Profile, PatchProfileInput>({
  mutationFn: input => api.me.patch(input),
  invalidates: [keys.profile()]
})
