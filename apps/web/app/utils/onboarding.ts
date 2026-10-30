import type { Project } from '@corral/contracts'
import type { DeviceMode } from './device'

// Where the setup middleware sends a navigation, or undefined to let it
// through. Onboarding is done once the server has a project, whichever
// browser or device asks (design/onboarding.md); nothing in the browser
// decides it. `projects` is null when the server couldn't be asked.
export function onboardingRedirect(
  to: { path: string, query: Record<string, unknown> },
  projects: Pick<Project, 'slug'>[] | null,
  mode: DeviceMode = 'web'
): string | undefined {
  if (!projects) return
  const first = projects[0]
  const setup = to.path === '/setup' || to.path.startsWith('/setup/')
  // The add-project flow reuses the wizard's repository step on both layouts.
  if (setup && (!first || to.query.add === '1')) return
  if (!first) return '/setup'
  if (to.path === '/' || setup) {
    return mode === 'mobile' ? '/home' : `/projects/${first.slug}`
  }
}
