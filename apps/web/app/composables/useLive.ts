import type { Agent, Epic, GlobalStatus, PlanSession, Profile, Project, RunEvent, RunnerStatus, ServerEvent, Task } from '@corral/contracts'
import { api } from './useApi'

// Everything the shell and pages show live. Loaded once, then kept current
// by the server's SSE stream (design/app-shell.md: "Everything stays live
// over the existing SSE connection"). Reconnects after drops (D12).
export interface LiveState {
  loaded: boolean
  error: string | null
  connection: 'connecting' | 'open' | 'reconnecting'
  projects: Project[]
  // Tasks by project ID, every status, filled in as pages ask for them
  tasks: Record<string, Task[]>
  // Epics by project ID, loaded with the project's tasks
  epics: Record<string, Epic[]>
  agents: Agent[]
  // The human's profile (their picture)
  profile: Profile | null
  runner: RunnerStatus | null
  status: GlobalStatus
  inboxCount: number
  planSessions: PlanSession[]
  // Live transcript lines by run, for the agent page
  runEvents: Record<string, RunEvent[]>
}

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 1000

export function useLive() {
  const route = useRoute()
  const state = useState<LiveState>('live', () => ({
    loaded: false,
    error: null,
    connection: 'connecting',
    projects: [],
    tasks: {},
    epics: {},
    agents: [],
    profile: null,
    runner: null,
    status: { stopped: false, updating: false },
    inboxCount: 0,
    planSessions: [],
    runEvents: {}
  }))

  async function load(): Promise<void> {
    try {
      const [projects, agents, runner, status, inbox, planSessions, profile] = await Promise.all([
        api.projects.list(), api.agents.list(), api.runner(), api.status(), api.inbox.get(), api.plan.sessions(), api.me.get()
      ])
      state.value.profile = profile
      state.value.projects = projects
      state.value.agents = agents
      state.value.runner = runner
      state.value.status = status
      state.value.inboxCount = inbox.needsYou.length
      state.value.planSessions = planSessions
      state.value.error = null
      state.value.loaded = true
    } catch (error) {
      state.value.error = error instanceof Error ? error.message : String(error)
    }
  }

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
    switch (event.type) {
      case 'project.created':
        s.projects.push(event.project)
        break
      case 'project.updated':
        s.projects = s.projects.map(p => p.id === event.project.id ? event.project : p)
        break
      case 'project.deleted':
        s.projects = s.projects.filter(p => p.id !== event.projectId)
        s.tasks = Object.fromEntries(Object.entries(s.tasks).filter(([id]) => id !== event.projectId))
        s.epics = Object.fromEntries(Object.entries(s.epics).filter(([id]) => id !== event.projectId))
        s.planSessions = s.planSessions.filter(x => x.projectId !== event.projectId)
        break
      case 'task.created':
      case 'task.updated':
        upsertTask(event.task)
        break
      case 'profile.updated':
        s.profile = event.profile
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
      case 'runner.status':
        s.runner = event.status
        break
      case 'agent.updated':
        // A new agent (Add agent in Settings) is appended
        s.agents = s.agents.some(a => a.id === event.agent.id)
          ? s.agents.map(a => a.id === event.agent.id ? event.agent : a)
          : [...s.agents, event.agent]
        break
      case 'run.updated':
        // Lease changes show on agents; refresh their counts cheaply
        void api.agents.list().then((agents) => {
          s.agents = agents
        })
        break
      case 'run.events': {
        const lines = s.runEvents[event.runId]
        if (lines) lines.push(...event.events)
        break
      }
      case 'global.status':
        s.status = event.status
        break
      case 'plan.session':
        if (event.session.unread && route.params.sessionId === event.session.id) {
          event.session = { ...event.session, unread: false }
          void api.plan.read(event.session.id).catch(() => {})
        }
        s.planSessions = [event.session, ...s.planSessions.filter(x => x.id !== event.session.id)]
        break
      default:
        break
    }
    // Inbox counts depend on task status; recount from the tasks we know,
    // and ask the server when we don't know the project's tasks
    if (event.type === 'task.updated' || event.type === 'task.deleted' || event.type === 'task.created' || event.type === 'project.deleted') {
      void api.inbox.get().then((inbox) => {
        s.inboxCount = inbox.needsYou.length
      })
    }
    for (const listener of listeners) listener(event)
  }

  function connect(): void {
    if (source || !import.meta.client) return
    // The static prototype has no server to stream from; its mock API sends
    // the events a write would have caused
    if (import.meta.prototype) {
      state.value.connection = 'open'
      void import('~/prototype/mock-api').then(({ onMockEvent }) => onMockEvent(apply))
      return
    }
    state.value.connection = source ? 'open' : state.value.connection
    source = new EventSource('/api/events')
    const types: ServerEvent['type'][] = [
      'project.created', 'project.updated', 'project.deleted', 'task.created', 'task.updated', 'task.deleted', 'runner.status', 'run.updated',
      'run.events', 'agent.updated', 'global.status', 'plan.session', 'plan.message', 'plan.updated', 'plan.drafts', 'epic.updated', 'profile.updated', 'comment.created'
    ]
    for (const type of types) {
      source.addEventListener(type, (message) => {
        apply(JSON.parse((message as MessageEvent).data) as ServerEvent)
      })
    }
    source.addEventListener('ready', () => {
      const wasReconnecting = state.value.connection === 'reconnecting'
      state.value.connection = 'open'
      retryMs = 1000
      // Anything missed while disconnected
      if (wasReconnecting) void load()
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
  function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function watchRun(runId: string, initial: RunEvent[]): void {
    state.value.runEvents[runId] = initial
  }

  return { state, load, loadTasks, connect, subscribe, watchRun }
}
