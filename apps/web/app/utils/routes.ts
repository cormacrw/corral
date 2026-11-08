import type { Agent, Project } from '@corral/contracts'

// The app's places and how each shell treats them (design/app-shell.md,
// design/mobile.md, design/settings.md). The desktop shell, the mobile layout
// and header, search and the settings menus all read this, so a page is
// added here once. PAGE_PATTERNS in contracts lists the page files.

export const SECTIONS = {
  home: { label: 'Home', to: '/home' },
  agents: { label: 'Agents', to: '/agents' },
  plan: { label: 'Plan', to: '/plan' },
  inbox: { label: 'Inbox', to: '/inbox' },
  projects: { label: 'Projects', to: '/projects' },
  settings: { label: 'Settings', to: '/settings' }
} as const
export type Section = keyof typeof SECTIONS

// The phone's tab bar, in order. Tasks and their subtasks belong to a project.
const MOBILE_TABS = [
  { section: 'home', icon: 'i-hugeicons-dashboard-square-02', also: ['/'] },
  { section: 'plan', icon: 'i-hugeicons-message-01', also: [] },
  { section: 'inbox', icon: 'i-hugeicons-inbox', also: [] },
  { section: 'projects', icon: 'i-hugeicons-folder-01', also: ['/tasks', '/epics'] },
  { section: 'settings', icon: 'i-hugeicons-settings-01', also: [] }
] as const satisfies { section: Section, icon: string, also: string[] }[]

// A project's own pages, after its overview
export const PROJECT_PAGES = [
  { page: 'board', label: 'Board', short: 'Board' },
  { page: 'backlog', label: 'Backlog', short: 'Backlog' },
  { page: 'pull-requests', label: 'Pull requests', short: 'PRs' },
  { page: 'settings', label: 'Settings', short: 'Settings' }
] as const
export type ProjectPage = typeof PROJECT_PAGES[number]['page']

// Settings sections, in menu order. On a phone, `fullBleed` sections lay
// themselves out edge to edge instead of under a page header.
export const SETTINGS_SECTIONS = [
  { section: 'profile', label: 'Profile', icon: 'i-hugeicons-user', fullBleed: false },
  { section: 'agents', label: 'Agents', icon: 'i-hugeicons-robot-01', fullBleed: true },
  { section: 'runner', label: 'Runners', icon: 'i-hugeicons-server-stack-01', fullBleed: true },
  { section: 'performance', label: 'Performance', icon: 'i-hugeicons-dashboard-speed-02', fullBleed: false },
  { section: 'appearance', label: 'Appearance', icon: 'i-hugeicons-paint-board', fullBleed: false }
] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]['section']

export const projectPath = (slug: string, page?: ProjectPage) => `/projects/${slug}${page ? `/${page}` : ''}`
export const agentPath = (name: string) => `/agents/${name.toLowerCase()}`
export const settingsPath = (section: SettingsSection) => `/settings/${section}`
export const runPath = (agent: string, runId: string) => `${agentPath(agent)}/${runId}`
// A new Plan conversation, about a project when given one
export const planPath = (projectId?: string | null) => projectId ? `/plan?project=${projectId}` : '/plan'
export const planThreadPath = (sessionId: string) => `/plan/${sessionId}`
export const inboxPath = (itemId?: string | null) => itemId ? `/inbox/${itemId}` : '/inbox'
export const taskPath = (ref: string) => `/tasks/${ref}`
export const epicPath = (id: string) => `/epics/${id}`
export const SETUP_PATH = '/setup'
// Setup's repository step, adding another project
export const ADD_PROJECT_PATH = `${SETUP_PATH}?step=repo&add=1`

export const projectPage = (page: string | undefined) => PROJECT_PAGES.find(p => p.page === page)
export const settingsSection = (section: string | undefined) => SETTINGS_SECTIONS.find(s => s.section === section)
const agentName = (agents: Pick<Agent, 'name'>[], id: string) => agents.find(a => a.name.toLowerCase() === id)?.name ?? 'Agent'

// A path's parts: /projects/<slug>/<page>, /agents/<name>/<run>, ...
function routeParts(path: string) {
  const [section, id, page] = path.split('/').filter(Boolean)
  return { section, id, page }
}

// The page title in the web layout's bar below 1024px
export function shellTitle(path: string, projects: Pick<Project, 'slug' | 'name'>[], agents: Pick<Agent, 'name'>[]): string {
  const { section, id, page } = routeParts(path)
  if (section === 'projects' && id) {
    const name = projects.find(p => p.slug === id)?.name ?? id
    const sub = projectPage(page)
    return sub ? `${name} · ${sub.label}` : name
  }
  if (section === 'agents' && id) return agentName(agents, id)
  if (section === 'tasks' && id) return id
  if (section === 'epics') return 'Task'
  return SECTIONS[section as Section]?.label ?? 'Corral'
}

// The phone header's title on a page without its own sub-page header
export function mobileTitle(path: string, agents: Pick<Agent, 'name'>[]): string {
  const { section, id } = routeParts(path)
  switch (section) {
    case 'settings': return settingsSection(id)?.label ?? 'Settings'
    case 'tasks': return id ?? 'Task'
    case 'epics': return 'Task'
    case 'projects': return id ? 'Overview' : 'Projects'
    case 'agents': return id ? agentName(agents, id) : 'Agents'
    default: return SECTIONS[section as Section]?.label ?? 'Corral'
  }
}

// How the phone shell frames a path
export function mobileChrome(path: string) {
  const parts = path.split('/').filter(Boolean)
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
  const tabs = MOBILE_TABS.map(tab => ({ ...tab, active: under(SECTIONS[tab.section].to) || tab.also.some(p => p === '/' ? path === '/' : under(p)) }))
  return {
    tabs,
    // A tab's first screen, which starts below the status bar
    tabRoot: MOBILE_TABS.some(tab => SECTIONS[tab.section].to === path),
    // Task pages draw their own header
    ownHeader: under('/tasks') || under('/epics'),
    // An agent's run fills the screen
    fullScreen: parts[0] === 'agents' && parts.length >= 3,
    // A Plan conversation or Inbox item keeps its own composer or action bar in place of the tab bar
    focused: ['plan', 'inbox'].includes(parts[0] ?? '') && parts.length >= 2,
    noTabBar: under('/tasks')
  }
}
