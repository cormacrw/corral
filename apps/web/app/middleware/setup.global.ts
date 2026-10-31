import { useQueryClient } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { keys } from '~/queries/keys'
import { onboardingRedirect } from '~/utils/onboarding'

// First run: with no projects, everything leads to onboarding; once the
// server has one, onboarding is over on every device (design/onboarding.md)
export default defineNuxtRouteMiddleware(async (to) => {
  // Resolve media queries and the saved override before choosing a landing page.
  // useDevice initializes synchronously, including on a cold standalone launch.
  const { mode } = useDevice()
  const client = useQueryClient()
  let projects = client.getQueryData<Project[]>(keys.projects.list())
  if (!projects) {
    // One attempt, not the query's: a cold launch can't wait out retries. The
    // shell finds the list cached and doesn't ask again.
    try {
      const list = await api.projects.list()
      // Anything but a list (say, a proxy's HTML page) says nothing either way
      if (!Array.isArray(list)) return
      projects = client.setQueryData<Project[]>(keys.projects.list(), list)!
    } catch {
      // The server is unreachable; pages show the error themselves
      return
    }
  }
  const target = onboardingRedirect(to, projects, mode.value)
  if (target) return navigateTo(target)
})
