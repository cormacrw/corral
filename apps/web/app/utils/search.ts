import type { Agent, Epic, PlanSession, Project, Task } from '@corral/contracts'
import { ROLE } from '~/utils/labels'

// What the search lists (design/app-shell.md's command palette, and the
// mobile Search screen in design/mobile.md). The web palette and mobile
// share the pages, so both go to the same places.
export interface SearchPage {
  label: string
  icon: string
  to: string
}

export function searchPages(projects: Project[], agents: Agent[]): SearchPage[] {
  return [
    { label: 'Plan', icon: 'i-lucide-message-square', to: '/plan' },
    { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox' },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings/profile' },
    ...projects.flatMap(p => [
      { label: `${p.name} · Overview`, icon: 'i-lucide-layout-dashboard', to: `/projects/${p.slug}` },
      { label: `${p.name} · Board`, icon: 'i-lucide-kanban', to: `/projects/${p.slug}/board` },
      { label: `${p.name} · Backlog`, icon: 'i-lucide-list', to: `/projects/${p.slug}/backlog` },
      { label: `${p.name} · Pull requests`, icon: 'i-lucide-git-pull-request', to: `/projects/${p.slug}/pull-requests` }
    ]),
    ...agents.map(a => ({ label: `${a.name} · ${ROLE[a.role]}`, icon: 'i-lucide-bot', to: `/agents/${a.name.toLowerCase()}` }))
  ]
}

export interface SearchData {
  projects: Project[]
  agents: Agent[]
  tasks: Task[]
  epics: Epic[]
  planSessions: PlanSession[]
}

export interface MobileSearchResults {
  pages: SearchPage[]
  epics: Epic[]
  tasks: Task[]
  sessions: PlanSession[]
}

// Each group is capped so a short query stays one screen of results
export const SEARCH_LIMIT = 8

const matches = (query: string, ...texts: string[]) => texts.some(text => text.toLowerCase().includes(query))

// The mobile Search screen: with no query it offers only the pages to go
// to; a query matches labels, titles and task refs, case-insensitively
export function mobileSearch(query: string, data: SearchData, limit = SEARCH_LIMIT): MobileSearchResults {
  const q = query.trim().toLowerCase()
  const pages = searchPages(data.projects, data.agents)
  if (!q) return { pages: pages.slice(0, limit), epics: [], tasks: [], sessions: [] }
  return {
    pages: pages.filter(p => matches(q, p.label)).slice(0, limit),
    epics: data.epics.filter(e => matches(q, e.title)).slice(0, limit),
    tasks: data.tasks.filter(t => matches(q, t.title, t.ref)).slice(0, limit),
    sessions: data.planSessions.filter(s => matches(q, s.title)).slice(0, limit)
  }
}

// Splits text around the first case-insensitive match, so the matched part
// can be bold
export function highlight(text: string, query: string): { before: string, match: string, after: string } {
  const q = query.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return { before: text, match: '', after: '' }
  return { before: text.slice(0, at), match: text.slice(at, at + q.length), after: text.slice(at + q.length) }
}
