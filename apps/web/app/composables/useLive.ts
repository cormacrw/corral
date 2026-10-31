import type { Agent, Epic, GlobalStatus, PlanSession, Profile, Project, RunnerStatus, ServerEvent, Task } from '@corral/contracts'
import { serverEventTypes } from '~/queries/dependencies'
import { shell } from '~/queries/shell'
import { api } from './useApi'

// What pages show live, kept current by the server's SSE stream
// (design/app-shell.md: "Everything stays live over the existing SSE
// connection"). Reconnects after drops (D12).
export interface LiveState {
  connection: 'connecting' | 'open' | 'reconnecting'
  // Tasks by project ID, every status, filled in as pages ask for them
  tasks: Record<string, Task[]>
  // Epics by project ID, loaded with the project's tasks
  epics: Record<string, Epic[]>
  // Compatibility getters over queries/shell.ts, until pages read queries
  readonly loaded: boolean
  readonly error: string | null
  readonly projects: Project[]
  readonly agents: Agent[]
  // The human's profile (their picture)
  readonly profile: Profile | null
  readonly runner: RunnerStatus | null
  readonly status: GlobalStatus
  readonly inboxCount: number
  readonly planSessions: PlanSession[]
}

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()
const reconnectListeners = new Set<() => void>()
let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 1000

// Every event on the stream, real or mock. Needs no component, for the query
// layer's plugin.
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Called when the stream comes back after a drop
export function subscribeReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener)
  return () => reconnectListeners.delete(listener)
}

export function useLive() {
  const route = useRoute()
  const pending = usePendingPlan()
  const state = useState<LiveState>('live', () => ({
    connection: 'connecting',
    tasks: {},
    epics: {},
    get loaded() { return shell()?.loaded.value ?? false },
    get error() { return shell()?.error.value ?? null },
    get projects() { return shell()?.projects.data.value ?? [] },
    get agents() { return shell()?.agents.data.value ?? [] },
    get profile() { return shell()?.profile.data.value ?? null },
    get runner() { return shell()?.runner.data.value ?? null },
    get status() { return shell()?.status.data.value ?? { stopped: false, updating: false } },
    get inboxCount() { return shell()?.inboxCount.data.value ?? 0 },
    get planSessions() { return shell()?.planSessions.data.value ?? [] }
  }))

  async function loadTasks(project: Project): Promise<Task[]> {
    const [tasks, epics] = await Promise.all([api.tasks.list(project.slug, 'all'), api.epics.list(project.slug)])
    state.value.tasks[project.id] = tasks
    state.value.epics[project.id] = epics
    return tasks
  }

  // Drafts live only in their plan, not in the project's task list
  function upsertTask(task: Task): void {
    const list = state.value.tasks[task.projectId]
    if (!list) return
    const index = list.findIndex(t => t.id === task.id)
    if (task.status === 'draft') {
      if (index >= 0) list.splice(index, 1)
    } else if (index >= 0) list.splice(index, 1, task)
    else list.push(task)
  }

  function apply(event: ServerEvent): void {
    const s = state.value
    pending.apply(event)
    switch (event.type) {
      case 'project.deleted':
        s.tasks = Object.fromEntries(Object.entries(s.tasks).filter(([id]) => id !== event.projectId))
        s.epics = Object.fromEntries(Object.entries(s.epics).filter(([id]) => id !== event.projectId))
        break
      case 'task.created':
      case 'task.updated':
        upsertTask(event.task)
        break
      case 'epic.updated': {
        const list = s.epics[event.epic.projectId]
        if (!list) break
        const index = list.findIndex(e => e.id === event.epic.id)
        if (index >= 0) list.splice(index, 1, event.epic)
        else list.push(event.epic)
        break
      }
      case 'task.deleted': {
        const list = s.tasks[event.projectId]
        if (list) s.tasks[event.projectId] = list.filter(t => t.id !== event.taskId)
        break
      }
      case 'plan.session':
        // Before the listeners, so the query cache gets the session as read
        if (event.session.unread && route.params.sessionId === event.session.id) {
          event.session = { ...event.session, unread: false }
          void api.plan.read(event.session.id).catch(() => {})
        }
        break
      default:
        break
    }
    for (const listener of listeners) listener(event)
  }

  function connect(): void {
    if (source || typeof window === 'undefined') return
    // The static prototype has no server to stream from; its mock API sends
    // the events a write would have caused
    if (import.meta.prototype) {
      state.value.connection = 'open'
      void import('~/prototype/mock-api').then(({ onMockEvent }) => onMockEvent(apply))
      return
    }
    state.value.connection = source ? 'open' : state.value.connection
    source = new EventSource('/api/events')
    for (const type of serverEventTypes) {
      source.addEventListener(type, (message) => {
        apply(JSON.parse((message as MessageEvent).data) as ServerEvent)
      })
    }
    source.addEventListener('ready', () => {
      const wasReconnecting = state.value.connection === 'reconnecting'
      state.value.connection = 'open'
      retryMs = 1000
      // Anything missed while disconnected
      if (wasReconnecting) {
        for (const listener of reconnectListeners) listener()
      }
    })
    source.onerror = () => {
      source?.close()
      source = null
      state.value.connection = 'reconnecting'
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 15_000)
    }
  }

  // Pages subscribe for events they render themselves (plan messages, comments)
  return { state, loadTasks, connect, subscribe: subscribeLive }
}
