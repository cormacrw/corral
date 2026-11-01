import type { Query, QueryClient, QueryKey } from '@tanstack/vue-query'
import { partialMatchKey } from '@tanstack/vue-query'
import type { Agent, Comment, Epic, EpicDetail, Inbox, PlanSession, PlanSessionDetail, Project, Run, RunEvent, ServerEvent, ServerEventType, Task } from '@corral/contracts'
import { keys } from './keys'

// What depends on what: the single place that says which queries an event or
// a mutation affects (wiki: query-layer).

type Update<T> = (current: T | undefined) => T | undefined

// How an event reaches the cache. Every read goes through here so `write` and
// `invalidates` stay declarative.
export interface EventCache {
  // Changes a cached entry. Returning undefined leaves it uncached.
  set: <T>(key: QueryKey, update: Update<T>) => void
  get: <T>(key: QueryKey) => T | undefined
  slug: (projectId: string) => string | undefined
  taskRef: (taskId: string) => string | undefined
  // The cached epics listing a task, so it can leave one as well as join one
  epicsWith: (taskId: string) => string[]
  clearProject: (projectId: string) => void
}

interface EventEffect<E extends ServerEvent> {
  // Events carrying a full entity write it straight into the cache
  write?: (event: E, cache: EventCache) => void
  // Derived data is refetched instead
  invalidates: (event: E, cache: EventCache) => readonly QueryKey[]
}

type EventDependencies = { [T in ServerEventType]: EventEffect<Extract<ServerEvent, { type: T }>> }

const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some(x => x.id === item.id) ? list.map(x => x.id === item.id ? item : x) : [...list, item]

// Updates a list only once it's loaded: a list made from one event would look
// complete
const upsertInto = <T extends { id: string }>(item: T): Update<T[]> => list => list && upsert(list, item)
const merge = <T>(patch: Partial<T>): Update<T> => current => current && { ...current, ...patch }

// A fetch can already hold lines whose event is still on its way, so a line
// counts by where it sits. Undefined when there is nothing to add: writing
// would mark the transcript fresh.
const addLines = (offset: number, events: RunEvent[]): Update<RunEvent[]> => (lines) => {
  if (!lines || offset > lines.length || offset + events.length <= lines.length) return undefined
  return [...lines, ...events.slice(lines.length - offset)]
}

// A posted comment's event can beat its response, so either one replaces the
// temporary entry
export const withComment = (comments: Comment[], comment: Comment): Comment[] =>
  upsert(comments.filter(c => !(c.id.startsWith('pending-') && c.body === comment.body)), comment)

const taskEpics = (task: Task, cache: EventCache): string[] =>
  [...new Set([...(task.epicId ? [task.epicId] : []), ...cache.epicsWith(task.id)])]

// Drafts live only in their plan, not in the project's task list
function writeTask(task: Task, cache: EventCache): void {
  cache.set<Task>(keys.tasks.detail(task.ref), current => current && task)
  for (const id of taskEpics(task, cache)) {
    cache.set<EpicDetail>(keys.epics.detail(id), epic => epic && { ...epic, tasks: task.epicId === id ? upsert(epic.tasks, task) : epic.tasks.filter(t => t.id !== task.id) })
  }
  const slug = cache.slug(task.projectId)
  if (!slug) return
  cache.set<Task[]>(keys.tasks.list(slug), list => list && (task.status === 'draft' ? list.filter(t => t.id !== task.id) : upsert(list, task)))
}

// Reading changes one row, so it needs no refetch. As on the server, a thread
// listed only for its unread reply leaves Needs you; a read release note stays.
export function inboxWithRead(current: Inbox, id: string): Inbox {
  const item = current.needsYou.find(i => i.id === id)
  if (item?.type === 'plan_thread' && item.status === 'none') {
    return { ...current, needsYou: current.needsYou.filter(i => i.id !== id), count: current.count - 1 }
  }
  if (item?.type !== 'plan_thread' && item?.type !== 'release_notes') return current
  return { ...current, needsYou: current.needsYou.map(i => i === item ? { ...item, unread: false } : i) }
}

// What a change to a project's tasks or runs leaves stale. A project not
// cached yet has no slug, so its lists go stale across all projects.
function projectStale(projectId: string, cache: EventCache): QueryKey[] {
  const slug = cache.slug(projectId)
  return slug ? [keys.projects.flow(slug), keys.projects.pullRequests(slug)] : [keys.projects.all()]
}

function taskStale(task: Task, cache: EventCache): QueryKey[] {
  return [
    keys.inbox(),
    keys.tasks.history(task.ref),
    keys.tasks.evidence(task.ref),
    keys.tasks.reviews(task.ref),
    keys.tasks.designs(task.ref),
    ...taskEpics(task, cache).map(keys.epics.detail),
    ...(cache.slug(task.projectId) ? [] : [keys.tasks.lists()]),
    ...projectStale(task.projectId, cache)
  ]
}

// What refetches once a project is gone. The list is here because a fetch in
// flight started before the removal and would bring the project back.
export const removedProjectStale = [keys.projects.list(), keys.inbox(), keys.tasks.lists(), keys.epics.lists(), keys.plan.all(), keys.runs.lists(), keys.setup.repos()]

// Typed by event, so a ServerEvent without an entry here doesn't compile
export const eventDependencies: EventDependencies = {
  'project.created': {
    write: ({ project }, cache) => cache.set<Project[]>(keys.projects.list(), upsertInto(project)),
    // Rows say which project uses them
    invalidates: () => [keys.setup.repos()]
  },
  'project.updated': {
    write: ({ project }, cache) => {
      cache.set<Project[]>(keys.projects.list(), upsertInto(project))
      cache.set<Project>(keys.projects.detail(project.slug), current => current && project)
    },
    invalidates: () => []
  },
  'project.deleted': {
    write: ({ projectId }, cache) => cache.clearProject(projectId),
    invalidates: () => removedProjectStale
  },
  'task.created': {
    write: ({ task }, cache) => writeTask(task, cache),
    invalidates: ({ task }, cache) => taskStale(task, cache)
  },
  'task.updated': {
    write: ({ task }, cache) => writeTask(task, cache),
    invalidates: ({ task }, cache) => taskStale(task, cache)
  },
  'task.deleted': {
    write: ({ taskId, projectId }, cache) => {
      const slug = cache.slug(projectId)
      if (slug) cache.set<Task[]>(keys.tasks.list(slug), list => list?.filter(t => t.id !== taskId))
    },
    invalidates: ({ taskId, projectId }, cache) => {
      const ref = cache.taskRef(taskId)
      return [
        keys.inbox(),
        keys.epics.details(),
        ...(ref ? [keys.tasks.detail(ref)] : []),
        ...(cache.slug(projectId) ? [] : [keys.tasks.lists()]),
        ...projectStale(projectId, cache)
      ]
    }
  },
  'comment.created': {
    write: ({ comment }, cache) => {
      const ref = cache.taskRef(comment.taskId)
      if (ref) cache.set<Comment[]>(keys.tasks.comments(ref), comments => comments && withComment(comments, comment))
    },
    // A comment adds no audit entry, so history and evidence stay as they are
    invalidates: ({ comment }, cache) => cache.taskRef(comment.taskId) ? [] : [keys.tasks.details()]
  },
  'epic.updated': {
    write: ({ epic }, cache) => {
      cache.set<EpicDetail>(keys.epics.detail(epic.id), merge<EpicDetail>(epic))
      const slug = cache.slug(epic.projectId)
      if (slug) cache.set<Epic[]>(keys.epics.list(slug), upsertInto(epic))
    },
    // Epic events reach its history through the audit log, not this payload
    invalidates: ({ epic }, cache) => [keys.inbox(), keys.epics.history(epic.id), ...(cache.slug(epic.projectId) ? [] : [keys.epics.lists()])]
  },
  'agent.updated': {
    write: ({ agent }, cache) => cache.set<Agent[]>(keys.agents.list(), upsertInto(agent)),
    invalidates: () => [keys.inbox()]
  },
  'run.updated': {
    write: ({ run }, cache) => {
      cache.set<Run>(keys.runs.detail(run.id), current => current && run)
      cache.set<Run[]>(keys.runs.list({ agentId: run.agentId }), runs => runs && (runs.some(r => r.id === run.id) ? upsert(runs, run) : [run, ...runs]))
    },
    // Lease changes show as counts on agents, a run's end goes in the task's
    // history, and it can add evidence, a review, a design version or a push to
    // the PR. Only the end: the PR is a GitHub read through the runner.
    invalidates: ({ run }, cache) => [
      keys.runs.lists(), keys.agents.list(), keys.inbox(),
      ...(run.taskRef ? [keys.tasks.history(run.taskRef), keys.tasks.evidence(run.taskRef), keys.tasks.reviews(run.taskRef), keys.tasks.designs(run.taskRef), ...(run.endedAt ? [keys.tasks.pullRequests(run.taskRef)] : [])] : []),
      ...projectStale(run.projectId, cache)
    ]
  },
  'run.events': {
    write: ({ runId, offset, events }, cache) => cache.set<RunEvent[]>(keys.runs.transcript(runId), addLines(offset, events)),
    // Lines were missed, or the first fetch failed: only a fetch can fill in
    invalidates: ({ runId, offset }, cache) => {
      const lines = cache.get<RunEvent[]>(keys.runs.transcript(runId))
      return lines && offset <= lines.length ? [] : [keys.runs.transcript(runId)]
    }
  },
  'runner.status': {
    write: ({ status }, cache) => cache.set(keys.runner(), () => status),
    invalidates: () => [keys.status()]
  },
  'global.status': {
    write: ({ status }, cache) => cache.set(keys.status(), merge(status)),
    invalidates: () => []
  },
  'plan.session': {
    write: ({ session, markedRead }, cache) => {
      if (markedRead) cache.set<Inbox>(keys.inbox(), inbox => inbox && { ...inboxWithRead(inbox, session.id), count: markedRead.inboxCount })
      cache.set<PlanSession[]>(keys.plan.sessions(), (list) => {
        if (!list) return list
        const previous = list.find(s => s.id === session.id)
        // Read echoes keep the timestamp: preserve order for acknowledgements.
        return previous?.updatedAt === session.updatedAt ? upsert(list, session) : [session, ...list.filter(s => s.id !== session.id)]
      })
      cache.set<PlanSessionDetail>(keys.plan.session(session.id), merge<PlanSessionDetail>(session))
    },
    invalidates: ({ markedRead }) => markedRead ? [] : [keys.inbox()]
  },
  'plan.message': {
    write: ({ message }, cache) => cache.set<PlanSessionDetail>(keys.plan.session(message.sessionId), detail => detail && { ...detail, messages: upsert(message.role === 'human' ? detail.messages.filter(m => !m.id.startsWith('pending-')) : detail.messages, message) }),
    invalidates: () => []
  },
  'plan.updated': {
    write: ({ plan }, cache) => cache.set<PlanSessionDetail>(keys.plan.session(plan.sessionId), detail => detail && { ...detail, plans: upsert(detail.plans, plan) }),
    invalidates: () => []
  },
  'plan.drafts': {
    write: ({ projectId, sessions }, cache) => {
      const slug = cache.slug(projectId)
      if (slug) cache.set(keys.plan.drafts(slug), () => sessions)
    },
    invalidates: ({ projectId }, cache) => cache.slug(projectId) ? [] : [keys.plan.all()]
  },
  'profile.updated': {
    write: ({ profile }, cache) => cache.set(keys.profile(), () => profile),
    invalidates: () => []
  },
  'deployment.updated': {
    // The Inbox is the only thing showing deployments; reading changes no content
    write: ({ deployment, markedRead }, cache) => {
      if (markedRead) cache.set<Inbox>(keys.inbox(), inbox => inbox && inboxWithRead(inbox, deployment.id))
    },
    invalidates: ({ markedRead }) => markedRead ? [] : [keys.inbox()]
  }
}

export const serverEventTypes = Object.keys(eventDependencies) as ServerEventType[]

// Marks each query once and refetches the active ones, however many of the
// keys cover it, so overlapping keys never fetch a query twice.
export function invalidateKeys(client: QueryClient, stale: readonly QueryKey[]): Promise<void> {
  if (!stale.length) return Promise.resolve()
  return client.invalidateQueries({ predicate: query => stale.some(key => partialMatchKey(query.queryKey, key)) })
}

function cachedTasks(client: QueryClient): Task[] {
  const details = client.getQueriesData<Task>({ queryKey: keys.tasks.details(), predicate: query => query.queryKey.length === keys.tasks.detail('').length })
  const lists = client.getQueriesData<Task[]>({ queryKey: keys.tasks.lists() })
  return [...details.flatMap(([, task]) => task ?? []), ...lists.flatMap(([, list]) => list ?? [])]
}

// Drops everything cached for a project, so none of it can show again. The
// removal's response and its event both land here, in either order; the second
// finds nothing left.
export function clearProject(client: QueryClient, projectId: string): void {
  const slug = client.getQueryData<Project[]>(keys.projects.list())?.find(p => p.id === projectId)?.slug
  const owned = (queryKey: QueryKey) => client.getQueriesData<{ projectId?: string }>({ queryKey })
    .filter(([, data]) => data?.projectId === projectId)
    .map(([key]) => key)
  const removed = [
    ...(slug ? [keys.projects.detail(slug), keys.tasks.list(slug), keys.epics.list(slug), keys.plan.drafts(slug)] : []),
    ...cachedTasks(client).filter(task => task.projectId === projectId).map(task => keys.tasks.detail(task.ref)),
    ...owned(keys.epics.details()),
    ...owned(keys.runs.all()),
    ...owned(keys.plan.sessions())
  ]
  const isRemoved = (query: Query) => removed.some(key => partialMatchKey(query.queryKey, key))
  client.removeQueries({ predicate: query => isRemoved(query) && !query.isActive() })
  // A mounted observer keeps showing a removed query's data, so one still on
  // screen loses it and refetches to the server's 404
  void client.resetQueries({ predicate: isRemoved })
  // These lists span projects, so they lose its rows and stay
  const others = <T extends { projectId: string }>(list: T[] | undefined) => list?.filter(item => item.projectId !== projectId)
  client.setQueriesData<Run[]>({ queryKey: keys.runs.lists() }, others)
  client.setQueryData<PlanSession[]>(keys.plan.sessions(), others)
  client.setQueryData<Project[]>(keys.projects.list(), list => list?.filter(p => p.id !== projectId))
}

function eventCache(client: QueryClient, raced: QueryKey[]): EventCache {
  return {
    set: (key, update) => {
      client.setQueryData(key, update)
      // A fetch already in flight started before this change and would
      // overwrite it, so the key needs a fetch that starts after
      if (client.getQueryState(key)?.fetchStatus === 'fetching') raced.push(key)
    },
    get: key => client.getQueryData(key),
    slug: projectId => client.getQueryData<Project[]>(keys.projects.list())?.find(p => p.id === projectId)?.slug,
    taskRef: taskId => cachedTasks(client).find(t => t.id === taskId)?.ref,
    epicsWith: taskId => client.getQueriesData<EpicDetail>({ queryKey: keys.epics.details() })
      .filter(([, epic]) => epic?.tasks.some(t => t.id === taskId))
      .map(([, epic]) => epic!.id),
    clearProject: projectId => clearProject(client, projectId)
  }
}

// Writes the event's entity and returns the keys it leaves stale. The keys are
// read first: a write can remove what they're looked up from.
export function applyEvent(client: QueryClient, event: ServerEvent): QueryKey[] {
  const raced: QueryKey[] = []
  const cache = eventCache(client, raced)
  const effect = eventDependencies[event.type] as EventEffect<ServerEvent>
  const stale = effect.invalidates(event, cache)
  effect.write?.(event, cache)
  return [...stale, ...raced]
}

export interface MutationDefinition<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>
  // Puts in the cache what a refetch can't get, before anything is invalidated
  write?: (client: QueryClient, data: TData, variables: TVariables) => void
  // Either fixed keys, or keys that depend on the result
  invalidates: readonly QueryKey[] | ((data: TData, variables: TVariables) => readonly QueryKey[])
}

// Options for useMutation. A mutation says what it changes; nothing reloads by
// hand. Invalidation runs only on success, and waits for the refetch, so a
// caller's pending state ends once the screen is current. A failure rejects
// mutateAsync and sets `error`.
export function defineMutation<TData, TVariables = void>({ mutationFn, write, invalidates }: MutationDefinition<TData, TVariables>) {
  return {
    mutationFn,
    onSuccess: (data: TData, variables: TVariables, _result: unknown, { client }: { client: QueryClient }) => {
      write?.(client, data, variables)
      return invalidateKeys(client, typeof invalidates === 'function' ? invalidates(data, variables) : invalidates)
    }
  }
}
