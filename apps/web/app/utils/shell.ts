import type { Agent, Project } from '@corral/contracts'

const PROJECT_PAGES: Record<string, string> = { 'board': 'Board', 'backlog': 'Backlog', 'pull-requests': 'Pull requests', 'settings': 'Settings' }
const SECTIONS: Record<string, string> = { home: 'Home', plan: 'Plan', inbox: 'Inbox', projects: 'Projects', settings: 'Settings', agents: 'Agents' }

// The page title in the web layout's bar below 1024px (design/app-shell.md)
export function shellTitle(path: string, projects: Pick<Project, 'slug' | 'name'>[], agents: Pick<Agent, 'name'>[]): string {
  const [section, id, page] = path.split('/').filter(Boolean)
  if (section === 'projects' && id) {
    const name = projects.find(p => p.slug === id)?.name ?? id
    return page && PROJECT_PAGES[page] ? `${name} · ${PROJECT_PAGES[page]}` : name
  }
  if (section === 'agents' && id) return agents.find(a => a.name.toLowerCase() === id)?.name ?? 'Agent'
  if (section === 'tasks' && id) return id
  if (section === 'epics') return 'Epic'
  return SECTIONS[section ?? ''] ?? 'Corral'
}
