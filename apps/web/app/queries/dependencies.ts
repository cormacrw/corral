import type { Query, QueryClient, QueryKey } from '@tanstack/vue-query'
import { partialMatchKey } from '@tanstack/vue-query'
import { ACTIVE_RUN_STATES } from '@corral/core'
import type { Agent, Comment, Epic, EpicDetail, Inbox, Plan, PlanMessage, PlanSession, PlanSessionDetail, Project, Run, RunEvent, ServerEvent, ServerEventType, Task } from '@corral/contracts'
import { runnerItemId, runnerUpdateProblem } from '@corral/contracts/client'
import { ApiError } from './client'
import { isPendingId, keys, projectData, type RunFilter } from './keys'

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
  runLists: () => QueryKey[]
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

// The one way to change cached data in place. A fetch already in flight
// started before the change and would overwrite it, so the change is applied
// again to what that fetch returns.
export function writeQuery<T>(client: QueryClient, key: QueryKey, update: Update<T>): void {
  client.setQueryData<T>(key, update)
  const cache = client.getQueryCache()
  const query = cache.find({ queryKey: key, exact: true })
  if (query?.state.fetchStatus !== 'fetching') return
  const stop = cache.subscribe((event) => {
    if (event.type !== 'updated' || event.query !== query) return
    const { action } = event
    if (action.type === 'success') {
      // Another write, perhaps an earlier one replaying
      if (action.manual) return
      client.setQueryData<T>(key, update)
    } else if (action.type !== 'error' && query.state.fetchStatus !== 'idle') return
    stop()
  })
}

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
  upsert(comments.filter(c => !(isPendingId(c.id) && c.body === comment.body)), comment)

// A Plan thread started here, shown before the server has it (optimistic-plan-starts.md)
export interface PlanStart {
  session: PlanSessionDetail
  message: string
  taskRef?: string
  state: 'starting' | 'accepted' | 'failed'
  error: string | null
  sending: boolean
  // A plan.session event arrived, whose metadata is newer than the POST response
  sessionReceived: boolean
}
export type PlanStarts = Record<string, PlanStart>

const withPlanMessage = (message: PlanMessage): Update<PlanSessionDetail> => detail => detail && {
  ...detail, messages: upsert(message.role === 'human' ? detail.messages.filter(m => !isPendingId(m.id)) : detail.messages, message)
}
const withPlan = (plan: Plan): Update<PlanSessionDetail> => detail => detail && { ...detail, plans: upsert(detail.plans, plan) }

// A session event changes its thread, and the start still showing it. Any
// event but a plan revision proves the server has the thread.
function writeSession(cache: EventCache, id: string, update: Update<PlanSessionDetail>, proof: Partial<PlanStart> | null): void {
  cache.set<PlanSessionDetail>(keys.plan.session(id), update)
  cache.set<PlanStarts>(keys.plan.starts(), (starts) => {
    const start = starts?.[id]
    if (!start) return starts
    return { ...starts, [id]: { ...start, session: update(start.session)!, ...(proof && { state: 'accepted', error: null, ...proof }) } }
  })
}

// Keeps a filtered list as the server would return it, newest first. The server
// returns the latest 50, so one that's full can't say what fell off the end.
// A history window (`since`) returns up to RUN_HISTORY_LIMIT instead.
const RUN_LIST_LIMIT = 50
const RUN_HISTORY_LIMIT = 2000
const runMatches = (run: Run, { agentId, taskId, active, since }: RunFilter) =>
  (!agentId || run.agentId === agentId) && (!taskId || run.taskId === taskId) && (!active || (ACTIVE_RUN_STATES as readonly string[]).includes(run.state))
  && (!since || Date.parse(run.queuedAt) >= Date.parse(since))
const placeRun = (run: Run, filter: RunFilter): Update<Run[]> => (runs) => {
  if (!runs) return runs
  if (!runMatches(run, filter)) return runs.some(r => r.id === run.id) ? runs.filter(r => r.id !== run.id) : runs
  return runs.some(r => r.id === run.id) ? upsert(runs, run) : [run, ...runs].slice(0, filter.since ? RUN_HISTORY_LIMIT : RUN_LIST_LIMIT)
}

const taskEpics = (task: Task, cache: EventCache): string[] =>
  [...new Set([...(task.epicId ? [task.epicId] : []), ...cache.epicsWith(task.id)])]

// Drafts live only in their plan, not in the project's task list
export const inTaskList = (task: Pick<Task, 'status'>): boolean => task.status !== 'draft'

function writeTask(task: Task, cache: EventCache): void {
  cache.set<Task>(keys.tasks.detail(task.ref), current => current && task)
  for (const id of taskEpics(task, cache)) {
    cache.set<EpicDetail>(keys.epics.detail(id), epic => epic && { ...epic, tasks: task.epicId === id ? upsert(epic.tasks, task) : epic.tasks.filter(t => t.id !== task.id) })
  }
  const slug = cache.slug(task.projectId)
  if (!slug) return
  cache.set<Task[]>(keys.tasks.list(slug), list => list && (inTaskList(task) ? upsert(list, task) : list.filter(t => t.id !== task.id)))
}

// Reading changes one row, so it needs no refetch. It never changes what's
// listed or the count: a thread in Needs you still waits on a decision (D11).
// Item IDs don't repeat across types: tasks, epics, sessions and deployments
// are UUIDs, and audit-entry items are numbered or prefixed.
export function inboxWithRead(current: Inbox, id: string): Inbox {
  const read = <T extends { id: string, unread: boolean }>(i: T): T => i.id === id && i.unread ? { ...i, unread: false } : i
  return { ...current, needsYou: current.needsYou.map(read), activity: current.activity.map(read) }
}

// What a change to a project's tasks or runs leaves stale. A project not
// cached yet has no slug, so its lists go stale across all projects.
function projectStale(projectId: string, cache: EventCache): QueryKey[] {
  const slug = cache.slug(projectId)
  return slug ? [keys.projects.flow(slug), keys.projects.pullRequests(slug), keys.projects.workspaceFlow()] : [keys.projects.all()]
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

export const removedProjectStale = projectData.listing

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
    // Inbox rows carry the project's name
    invalidates: () => [keys.inbox()]
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
    invalidates: ({ epic }, cache) => [keys.inbox(), keys.epics.history(epic.id), keys.epics.activity(epic.id), keys.epics.review(epic.id), ...(cache.slug(epic.projectId) ? [] : [keys.epics.lists()])]
  },
  'agent.updated': {
    write: ({ agent }, cache) => cache.set<Agent[]>(keys.agents.list(), upsertInto(agent)),
    invalidates: () => [keys.inbox()]
  },
  'run.updated': {
    write: ({ run }, cache) => {
      for (const key of cache.runLists()) cache.set<Run[]>(key, placeRun(run, key.at(-1) as RunFilter))
    },
    // Lists take the run above. Lease changes show as counts on agents, a run's
    // end goes in the task's history, and it can add evidence, a review, a design
    // version or a push to the PR. Only the end: the PR is a GitHub read through
    // the runner.
    invalidates: ({ run }, cache) => [
      keys.agents.list(), keys.inbox(),
      ...(run.taskRef ? [keys.tasks.history(run.taskRef), keys.tasks.evidence(run.taskRef), keys.tasks.reviews(run.taskRef), keys.tasks.designs(run.taskRef), ...(run.endedAt ? [keys.tasks.pullRequests(run.taskRef)] : [])] : []),
      ...(run.projectId ? projectStale(run.projectId, cache) : [])
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
    // Heartbeats land here too, so only when the runners Needs you lists change
    invalidates: ({ status }, cache) => {
      const listed = cache.get<Inbox>(keys.inbox())?.needsYou.filter(i => i.type === 'runner_update').map(i => i.id).sort()
      const wanted = status.runners.filter(r => runnerUpdateProblem(r)).map(r => runnerItemId(r.id)).sort()
      return !listed || String(listed) === String(wanted) ? [keys.status()] : [keys.status(), keys.inbox()]
    }
  },
  'global.status': {
    write: ({ status }, cache) => cache.set(keys.status(), merge(status)),
    invalidates: () => []
  },
  'plan.session': {
    write: ({ session, markedRead }, cache) => {
      if (markedRead) cache.set<Inbox>(keys.inbox(), inbox => inbox && inboxWithRead(inbox, session.id))
      cache.set<PlanSession[]>(keys.plan.sessions(), (list) => {
        if (!list) return list
        const previous = list.find(s => s.id === session.id)
        // Read echoes keep the timestamp: preserve order for acknowledgements.
        return previous?.updatedAt === session.updatedAt ? upsert(list, session) : [session, ...list.filter(s => s.id !== session.id)]
      })
      writeSession(cache, session.id, merge<PlanSessionDetail>(session), { sessionReceived: true })
    },
    invalidates: ({ markedRead }) => markedRead ? [] : [keys.inbox()]
  },
  'plan.message': {
    write: ({ message }, cache) => writeSession(cache, message.sessionId, withPlanMessage(message), {}),
    invalidates: () => []
  },
  'plan.updated': {
    write: ({ plan }, cache) => writeSession(cache, plan.sessionId, withPlan(plan), null),
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
  'inbox.read': {
    write: ({ id }, cache) => cache.set<Inbox>(keys.inbox(), inbox => inbox && inboxWithRead(inbox, id)),
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
  const owned = (queryKey: QueryKey) => client.getQueriesData<{ projectId?: string | null }>({ queryKey })
    .filter(([, data]) => data?.projectId === projectId)
    .map(([key]) => key)
  const runs = client.getQueriesData<Run[]>({ queryKey: keys.runs.lists() }).flatMap(([, list]) => list ?? [])
  const removed = [
    ...(slug ? projectData.bySlug(slug) : []),
    ...cachedTasks(client).filter(task => task.projectId === projectId).map(task => keys.tasks.detail(task.ref)),
    ...runs.filter(run => run.projectId === projectId).map(run => keys.runs.transcript(run.id)),
    ...projectData.owned.flatMap(owned)
  ]
  const isRemoved = (query: Query) => removed.some(key => partialMatchKey(query.queryKey, key))
  client.removeQueries({ predicate: query => isRemoved(query) && !query.isActive() })
  // A mounted observer keeps showing a removed query's data, so one still on
  // screen loses it and refetches to the server's 404
  void client.resetQueries({ predicate: isRemoved })
  // Only the lists themselves, not the entries keyed under them
  const others = <T extends { projectId: string | null }>(list: T[] | undefined) => Array.isArray(list) ? list.filter(item => item.projectId !== projectId) : list
  for (const queryKey of projectData.spanning) client.setQueriesData<{ projectId: string | null }[]>({ queryKey }, others)
  client.setQueryData<Project[]>(keys.projects.list(), list => list?.filter(p => p.id !== projectId))
}

function eventCache(client: QueryClient): EventCache {
  return {
    set: (key, update) => writeQuery(client, key, update),
    get: key => client.getQueryData(key),
    slug: projectId => client.getQueryData<Project[]>(keys.projects.list())?.find(p => p.id === projectId)?.slug,
    taskRef: taskId => cachedTasks(client).find(t => t.id === taskId)?.ref,
    epicsWith: taskId => client.getQueriesData<EpicDetail>({ queryKey: keys.epics.details(), predicate: query => query.queryKey.length === keys.epics.detail('').length })
      .filter(([, epic]) => epic?.tasks.some(t => t.id === taskId))
      .map(([, epic]) => epic!.id),
    runLists: () => client.getQueriesData({ queryKey: keys.runs.lists() }).map(([key]) => key),
    clearProject: projectId => clearProject(client, projectId)
  }
}

// A mutation's response, written everywhere the task shows, as its event will
// be. The event can arrive first, so a response older than the cache is dropped.
export function writeTaskResponse(client: QueryClient, task: Task): void {
  if (cachedTasks(client).some(known => known.id === task.id && known.updatedAt > task.updatedAt)) return
  writeTask(task, eventCache(client))
}

// Writes the event's entity and returns the keys it leaves stale. The keys are
// read first: a write can remove what they're looked up from.
export function applyEvent(client: QueryClient, event: ServerEvent): readonly QueryKey[] {
  const cache = eventCache(client)
  const effect = eventDependencies[event.type] as EventEffect<ServerEvent>
  const stale = effect.invalidates(event, cache)
  effect.write?.(event, cache)
  return stale
}

type Stale<TData, TVariables> = readonly QueryKey[] | ((data: TData, variables: TVariables) => readonly QueryKey[])

export interface MutationDefinition<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>
  // Puts in the cache what a refetch can't get, before anything is invalidated
  write?: (client: QueryClient, data: TData, variables: TVariables) => void
  // Either fixed keys, or keys that depend on the result
  invalidates: Stale<TData, TVariables>
  // The same, without holding up the caller: data the screen isn't waiting on
  refreshes?: Stale<TData, TVariables>
  // Refetched before the caller hears of a 409: the server refused because
  // what the human saw had changed
  onConflict?: (variables: TVariables) => readonly QueryKey[]
}

// Options for useMutation. A mutation says what it changes; nothing reloads by
// hand. Invalidation runs only on success, and `invalidates` waits for the
// refetch, so a caller's pending state ends once the screen is current. A
// failure rejects mutateAsync and sets `error`.
export function defineMutation<TData, TVariables = void>({ mutationFn, write, invalidates, refreshes = [], onConflict }: MutationDefinition<TData, TVariables>) {
  const stale = (keys: Stale<TData, TVariables>, data: TData, variables: TVariables) => typeof keys === 'function' ? keys(data, variables) : keys
  return {
    mutationFn,
    onSuccess: (data: TData, variables: TVariables, _result: unknown, { client }: { client: QueryClient }) => {
      write?.(client, data, variables)
      void invalidateKeys(client, stale(refreshes, data, variables))
      return invalidateKeys(client, stale(invalidates, data, variables))
    },
    onError: (error: Error, variables: TVariables, _result: unknown, { client }: { client: QueryClient }) =>
      onConflict && error instanceof ApiError && error.status === 409 ? invalidateKeys(client, onConflict(variables)) : undefined
  }
}
