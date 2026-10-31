import type { QueryClient, QueryKey } from '@tanstack/vue-query'
import { partialMatchKey } from '@tanstack/vue-query'
import type { Agent, Comment, Epic, EpicDetail, PlanSession, PlanSessionDetail, Project, Run, RunEvent, ServerEvent, ServerEventType, Task } from '@corral/contracts'
import { keys } from './keys'

// What depends on what: the single place that says which queries an event or
// a mutation affects (wiki: query-layer).

type Update<T> = (current: T | undefined) => T | undefined

// How an event reaches the cache. Every read goes through here so `write` and
// `invalidates` stay declarative.
export interface EventCache {
  // Changes a cached entry. Returning undefined leaves it uncached.
  set: <T>(key: QueryKey, update: Update<T>) => void
  slug: (projectId: string) => string | undefined
  taskRef: (taskId: string) => string | undefined
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

// Drafts live only in their plan, not in the project's task list
function writeTask(task: Task, cache: EventCache): void {
  cache.set<Task>(keys.tasks.detail(task.ref), current => current && task)
  const slug = cache.slug(task.projectId)
  if (!slug) return
  cache.set<Task[]>(keys.tasks.list(slug), list => list && (task.status === 'draft' ? list.filter(t => t.id !== task.id) : upsert(list, task)))
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
    ...(task.epicId ? [keys.epics.detail(task.epicId)] : []),
    ...(cache.slug(task.projectId) ? [] : [keys.tasks.lists()]),
    ...projectStale(task.projectId, cache)
  ]
}

// Typed by event, so a ServerEvent without an entry here doesn't compile
export const eventDependencies: EventDependencies = {
  'project.created': {
    write: ({ project }, cache) => cache.set<Project[]>(keys.projects.list(), upsertInto(project)),
    invalidates: () => []
  },
  'project.updated': {
    write: ({ project }, cache) => {
      cache.set<Project[]>(keys.projects.list(), upsertInto(project))
      cache.set<Project>(keys.projects.detail(project.slug), current => current && project)
    },
    invalidates: () => []
  },
  'project.deleted': {
    write: ({ projectId }, cache) => cache.set<Project[]>(keys.projects.list(), list => list?.filter(p => p.id !== projectId)),
    invalidates: () => [keys.inbox(), keys.tasks.lists(), keys.epics.lists(), keys.plan.all()]
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
      if (ref) cache.set<Comment[]>(keys.tasks.comments(ref), upsertInto(comment))
    },
    invalidates: ({ comment }, cache) => {
      const ref = cache.taskRef(comment.taskId)
      return ref ? [keys.tasks.history(ref)] : [keys.tasks.details()]
    }
  },
  'epic.updated': {
    write: ({ epic }, cache) => {
      cache.set<EpicDetail>(keys.epics.detail(epic.id), merge<EpicDetail>(epic))
      const slug = cache.slug(epic.projectId)
      if (slug) cache.set<Epic[]>(keys.epics.list(slug), upsertInto(epic))
    },
    invalidates: ({ epic }, cache) => [keys.inbox(), ...(cache.slug(epic.projectId) ? [] : [keys.epics.lists()])]
  },
  'agent.updated': {
    write: ({ agent }, cache) => cache.set<Agent[]>(keys.agents.list(), upsertInto(agent)),
    invalidates: () => [keys.inbox()]
  },
  'run.updated': {
    write: ({ run }, cache) => cache.set<Run>(keys.runs.detail(run.id), current => current && run),
    // Lease changes show as counts on agents
    invalidates: ({ run }, cache) => [keys.runs.lists(), keys.agents.list(), keys.inbox(), ...projectStale(run.projectId, cache)]
  },
  'run.events': {
    write: ({ runId, events }, cache) => cache.set<RunEvent[]>(keys.runs.transcript(runId), lines => lines && [...lines, ...events]),
    invalidates: () => []
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
    write: ({ session }, cache) => {
      cache.set<PlanSession[]>(keys.plan.sessions(), (list) => {
        if (!list) return list
        const previous = list.find(s => s.id === session.id)
        // Read echoes keep the timestamp: preserve order for acknowledgements.
        return previous?.updatedAt === session.updatedAt ? upsert(list, session) : [session, ...list.filter(s => s.id !== session.id)]
      })
      cache.set<PlanSessionDetail>(keys.plan.session(session.id), merge<PlanSessionDetail>(session))
    },
    invalidates: () => [keys.inbox()]
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
    // The Inbox is the only thing showing deployments
    invalidates: () => [keys.inbox()]
  }
}

export const serverEventTypes = Object.keys(eventDependencies) as ServerEventType[]

// Marks each query once and refetches the active ones, however many of the
// keys cover it, so overlapping keys never fetch a query twice.
export function invalidateKeys(client: QueryClient, stale: readonly QueryKey[]): Promise<void> {
  if (!stale.length) return Promise.resolve()
  return client.invalidateQueries({ predicate: query => stale.some(key => partialMatchKey(query.queryKey, key)) })
}

function eventCache(client: QueryClient, raced: QueryKey[]): EventCache {
  return {
    set: (key, update) => {
      client.setQueryData(key, update)
      // A fetch already in flight started before this change and would
      // overwrite it, so the key needs a fetch that starts after
      if (client.getQueryState(key)?.fetchStatus === 'fetching') raced.push(key)
    },
    slug: projectId => client.getQueryData<Project[]>(keys.projects.list())?.find(p => p.id === projectId)?.slug,
    taskRef: (taskId) => {
      const details = client.getQueriesData<Task>({ queryKey: keys.tasks.details(), predicate: query => query.queryKey.length === keys.tasks.detail('').length })
      const lists = client.getQueriesData<Task[]>({ queryKey: keys.tasks.lists() })
      return [...details.flatMap(([, task]) => task ?? []), ...lists.flatMap(([, list]) => list ?? [])].find(t => t.id === taskId)?.ref
    }
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
  // Either fixed keys, or keys that depend on the result
  invalidates: readonly QueryKey[] | ((data: TData, variables: TVariables) => readonly QueryKey[])
}

// Options for useMutation. A mutation says what it changes; nothing reloads by
// hand. Invalidation runs only on success, and waits for the refetch, so a
// caller's pending state ends once the screen is current. A failure rejects
// mutateAsync and sets `error`.
export function defineMutation<TData, TVariables = void>({ mutationFn, invalidates }: MutationDefinition<TData, TVariables>) {
  return {
    mutationFn,
    onSuccess: (data: TData, variables: TVariables, _result: unknown, { client }: { client: QueryClient }) =>
      invalidateKeys(client, typeof invalidates === 'function' ? invalidates(data, variables) : invalidates)
  }
}
