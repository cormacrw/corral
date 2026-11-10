import { ROLE_LABELS } from '@corral/core'
import type { Agent, Project } from '@corral/contracts'
import { agentPath, PROJECT_PAGES, projectPath, SECTIONS, settingsPath, type ProjectPage } from '~/utils/routes'

// What the command palette lists (design/app-shell.md)
interface SearchPage {
  label: string
  icon: string
  to: string
}

// A project's pages that search offers: not its settings
const PROJECT_ICONS: Partial<Record<ProjectPage, string>> = { 'board': 'i-hugeicons-kanban', 'backlog': 'i-hugeicons-left-to-right-list-bullet', 'pull-requests': 'i-hugeicons-git-pull-request' }

export function searchPages(projects: Project[], agents: Agent[]): SearchPage[] {
  return [
    { label: SECTIONS.plan.label, icon: 'i-hugeicons-message-01', to: SECTIONS.plan.to },
    { label: SECTIONS.inbox.label, icon: 'i-hugeicons-inbox', to: SECTIONS.inbox.to },
    { label: SECTIONS.settings.label, icon: 'i-hugeicons-settings-01', to: settingsPath('profile') },
    ...projects.flatMap(p => [
      { label: `${p.name} · Overview`, icon: 'i-hugeicons-dashboard-square-01', to: projectPath(p.slug) },
      ...PROJECT_PAGES.flatMap(({ page, label }) => PROJECT_ICONS[page] ? [{ label: `${p.name} · ${label}`, icon: PROJECT_ICONS[page], to: projectPath(p.slug, page) }] : [])
    ]),
    ...agents.map(a => ({ label: `${a.name} · ${ROLE_LABELS[a.role]}`, icon: 'i-hugeicons-robot-01', to: agentPath(a.name) }))
  ]
}
