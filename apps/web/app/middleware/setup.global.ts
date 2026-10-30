import { api } from '~/composables/useApi'
import { onboardingRedirect } from '~/utils/onboarding'

// First run: with no projects, everything leads to onboarding; once the
// server has one, onboarding is over on every device (design/onboarding.md)
export default defineNuxtRouteMiddleware(async (to) => {
  // Resolve media queries and the saved override before choosing a landing page.
  // useDevice initializes synchronously, including on a cold standalone launch.
  const { mode } = useDevice()
  const live = useLive()
  if (!live.state.value.loaded) {
    try {
      const projects = await api.projects.list()
      // Anything but a list (say, a proxy's HTML page) says nothing either way
      if (!Array.isArray(projects)) return
      live.state.value.projects = projects
    } catch {
      // The server is unreachable; pages show the error themselves
      return
    }
  }
  const target = onboardingRedirect(to, live.state.value.projects, mode.value)
  if (target) return navigateTo(target)
})
