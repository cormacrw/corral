import { api } from '~/composables/useApi'

// First run: with no projects, everything leads to onboarding (design/onboarding.md)
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith('/setup')) return
  const live = useLive()
  if (!live.state.value.loaded) {
    try {
      live.state.value.projects = await api.projects.list()
    } catch {
      // The server is unreachable; pages show the error themselves
      return
    }
  }
  if (live.state.value.projects.length === 0) return navigateTo('/setup')
  if (to.path === '/') return navigateTo(`/projects/${live.state.value.projects[0]!.slug}`)
})
