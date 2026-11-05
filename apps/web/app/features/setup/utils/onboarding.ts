import type { Project, RepoChoice } from '@corral/contracts'

export const isSetupPath = (path: string) => path === '/setup' || path.startsWith('/setup/')

// Where the setup middleware sends a navigation, or undefined to let it
// through. Onboarding is done once the server has a project, whichever
// browser or device asks (design/onboarding.md); nothing in the browser
// decides it. `projects` is null when the server couldn't be asked. Once
// onboarded, / and the wizard open Home on every layout (design/home.md).
export function onboardingRedirect(
  to: { path: string, query: Record<string, unknown> },
  projects: Pick<Project, 'slug'>[] | null
): string | undefined {
  if (!projects) return
  const first = projects[0]
  const setup = isSetupPath(to.path)
  // The add-project flow reuses the wizard's repository step on both layouts.
  if (setup && (!first || to.query.add === '1')) return
  if (!first) return '/setup'
  if (to.path === '/' || setup) return '/home'
}

// What "Paste a GitHub URL" leaves for the access check: owner/name
export function repoFromUrl(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
}

// Why a repository can't be picked, under its description
export function repoBlockedReason(repo: Pick<RepoChoice, 'reason' | 'usedBy'>): string | null {
  if (!repo.reason) return null
  return repo.reason === 'read_only' ? 'Read-only access: agents couldn’t push branches or open PRs' : `Used by ${repo.usedBy?.name}`
}
