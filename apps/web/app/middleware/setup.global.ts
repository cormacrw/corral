import { useQueryClient } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { keys } from '~/queries/keys'
import { fetchProjectsOnce, projectsQuery } from '~/queries/projects'
import { isSetupPath, onboardingRedirect } from '~/utils/onboarding'

// First run: with no projects, everything leads to onboarding; once the
// server has one, onboarding is over on every device (design/onboarding.md)
export default defineNuxtRouteMiddleware(async (to) => {
  // Resolve media queries and the saved override before choosing a landing page.
  // useDevice initializes synchronously, including on a cold standalone launch.
  const { mode } = useDevice()
  const client = useQueryClient()
  let projects = client.getQueryData<Project[]>(keys.projects.list())
  if (!projects) {
    // Only / and the wizard depend on the answer to show anything. Any other
    // page opens straight away, and the shell's own request settles it. A
    // fresh install on a deep link sees that page briefly before onboarding.
    if (to.path !== '/' && !isSetupPath(to.path)) {
      const router = useRouter()
      void client.fetchQuery(projectsQuery()).then(async (list) => {
        if (!Array.isArray(list)) return
        // The first navigation may still be landing, and currentRoute isn't
        // the page until it has. By then the human may have moved on.
        await router.isReady()
        const target = onboardingRedirect(router.currentRoute.value, list, mode.value)
        if (target) await router.replace(target)
      }, () => {
        // The server is unreachable; pages show the error themselves
      })
      return
    }
    // One attempt, not the query's: a cold launch can't wait out retries. The
    // shell finds the list cached and doesn't ask again.
    try {
      const list = await fetchProjectsOnce()
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
