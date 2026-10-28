import {
  checkRepoInput,
  createProjectInput,
  createTaskInput,
  humanTransitionInput,
  SSE_HEARTBEAT_MS,
  taskListQuery,
  type ApiErrorBody,
  type ServerEvent
} from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database } from '@corral/db'
import { zValidator } from '@hono/zod-validator'
import { Hono, type ValidationTargets } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ZodType } from 'zod'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import type { EventBus } from './events.ts'
import { createProject, findProjectBySlug, listProjects, toProject } from './projects.ts'
import type { RunnerHub } from './runner-hub.ts'
import { checkRepository, detectClis, RepoCatalog } from './setup.ts'
import { createTask, findTaskId, listTasks, loadTask, transitionTask } from './tasks.ts'

export interface AppDeps {
  db: Database
  events: EventBus
  // Who web requests act as (see owner.ts)
  actor: Actor
  runner: RunnerHub
}

// Validation failures get the same error shape as every other API error
function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json<ApiErrorBody>({ error: { code: 'invalid_input', issues: result.error.issues } }, 400)
    }
  })
}

const taskNumber = (value: string) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new ApiFailure(404, { code: 'not_found' })
  return number
}

export function createApp({ db, events, actor, runner }: AppDeps) {
  const repos = new RepoCatalog(db, runner)

  return new Hono()
    .basePath('/api')
    .onError((error, c) => {
      const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
      if (failure) return c.json<ApiErrorBody>({ error: failure.body }, failure.status)
      console.error(error)
      return c.json({ error: { code: 'internal' } }, 500)
    })

    .get('/health', c => c.json({ ok: true }))

    .get('/runner', c => c.json(runner.status()))

    .get('/setup/repos', async c => c.json(await repos.list(c.req.query('refresh') === '1')))

    .post('/setup/check-repo', validate('json', checkRepoInput), async c =>
      c.json(await checkRepository(db, runner, c.req.valid('json').repository)))

    .get('/setup/clis', async c => c.json(await detectClis(runner)))

    .get('/projects', async c => c.json(await listProjects(db)))

    .post('/projects', validate('json', createProjectInput), async (c) => {
      const project = await createProject(db, c.req.valid('json'), actor)
      events.publish({ type: 'project.created', project })
      return c.json(project, 201)
    })

    .get('/projects/:slug', async c => c.json(toProject(await findProjectBySlug(db, c.req.param('slug')))))

    .get('/projects/:slug/tasks', validate('query', taskListQuery), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listTasks(db, project, c.req.valid('query').view))
    })

    .post('/projects/:slug/tasks', validate('json', createTaskInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const task = await loadTask(db, await createTask(db, project, c.req.valid('json'), actor))
      events.publish({ type: 'task.created', task })
      return c.json(task, 201)
    })

    .get('/projects/:slug/tasks/:number', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await loadTask(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .post('/projects/:slug/tasks/:number/transitions', validate('json', humanTransitionInput), async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      const taskId = await findTaskId(db, project.id, taskNumber(c.req.param('number')))
      await transitionTask(db, taskId, c.req.valid('json'), actor)
      // Published after the commit, so listeners never see a rolled-back state
      const task = await loadTask(db, taskId)
      events.publish({ type: 'task.updated', task })
      return c.json(task)
    })

    .get('/events', c => streamSSE(c, async (stream) => {
      const send = (event: ServerEvent) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      const unsubscribe = events.subscribe((event) => {
        void send(event)
      })
      // Cloudflare drops proxied connections idle for ~100 s (D12)
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' })
      }, SSE_HEARTBEAT_MS)
      await stream.writeSSE({ event: 'ready', data: '' })
      await new Promise<void>(resolve => stream.onAbort(resolve))
      clearInterval(heartbeat)
      unsubscribe()
    }))
}

// The Hono typed client (hc) in apps/web is built from this type
export type AppType = ReturnType<typeof createApp>
