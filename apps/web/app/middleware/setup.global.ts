import { useQueryClient } from '@tanstack/vue-query'
import type { Project } from '@corral/contracts'
import { keys } from '~/queries/keys'
import { fetchProjectsOnce, projectsQuery } from '~/queries/projects'
import { isSetupPath, onboardingRedirect } from '~/features/setup/utils/onboarding'

// First run: with no projects, everything leads to onboarding; once the
// server has one, onboarding is over on every device (design/onboarding.md)
export default defineNuxtRouteMiddleware(async (to) => {
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
        const target = onboardingRedirect(router.currentRoute.value, list)
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
      // JSON that isn't a list says nothing either way. A page that isn't JSON
      // at all, such as a proxy's, already failed in the request.
      if (!Array.isArray(list)) return
      projects = client.setQueryData<Project[]>(keys.projects.list(), list)!
    } catch {
      // The server is unreachable; pages show the error themselves
      return
    }
  }
  const target = onboardingRedirect(to, projects)
  if (target) return navigateTo(target)
})
