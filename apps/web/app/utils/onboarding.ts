import type { Project } from '@corral/contracts'

// Where the setup middleware sends a navigation, or undefined to let it
// through. Onboarding is done once the server has a project, whichever
// browser or device asks (design/onboarding.md); nothing in the browser
// decides it. `projects` is null when the server couldn't be asked.
export function onboardingRedirect(
  to: { path: string, query: Record<string, unknown> },
  projects: Pick<Project, 'slug'>[] | null
): string | undefined {
  if (!projects) return
  const first = projects[0]
  if (to.path === '/setup' || to.path.startsWith('/setup/')) {
    // The sidebar's add-project flow reuses the wizard's repository step
    if (!first || to.query.add === '1') return
    return `/projects/${first.slug}`
  }
  if (!first) return '/setup'
  if (to.path === '/') return `/projects/${first.slug}`
}
