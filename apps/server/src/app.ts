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
import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { Hono, type ValidationTargets } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ZodType } from 'zod'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import type { EventBus } from './events.ts'
import { createProject, findProjectBySlug, listProjects, toProject } from './projects.ts'
import type { BlobStore } from './blob-store.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { RunnerHub } from './runner-hub.ts'
import { getRun, listAgents, listEvidence, listRuns } from './runs.ts'
import type { Transcripts } from './transcripts.ts'
import { checkRepository, detectClis, RepoCatalog } from './setup.ts'
import { createTask, findTaskId, listTasks, loadTask, transitionTask } from './tasks.ts'

export interface AppDeps {
  db: Database
  events: EventBus
  // Who web requests act as (see owner.ts)
  actor: Actor
  runner: RunnerHub
  orchestrator: Orchestrator
  blobs: BlobStore
  transcripts: Transcripts
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

export function createApp({ db, events, actor, runner, orchestrator, blobs, transcripts }: AppDeps) {
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
      // Approval triggers an immediate scheduler check (flows.md step 1)
      orchestrator.poke()
      return c.json(task)
    })

    .get('/projects/:slug/tasks/:number/evidence', async (c) => {
      const project = await findProjectBySlug(db, c.req.param('slug'))
      return c.json(await listEvidence(db, await findTaskId(db, project.id, taskNumber(c.req.param('number')))))
    })

    .get('/evidence/:id/file', async (c) => {
      const [row] = await db.select().from(schema.evidence).where(eq(schema.evidence.id, c.req.param('id')))
      const data = row ? await blobs.get(row.blob) : null
      if (!row || !data) throw new ApiFailure(404, { code: 'not_found' })
      return c.body(new Uint8Array(data), 200, {
        'content-type': row.contentType,
        // Blobs are immutable, so they can be cached forever
        'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `inline; filename="${row.fileName.replace(/"/g, '')}"`
      })
    })

    .get('/agents', async c => c.json(await listAgents(db)))

    .get('/runs', async (c) => {
      const agentId = c.req.query('agentId')
      const taskId = c.req.query('taskId')
      return c.json(await listRuns(db, {
        ...(agentId && { agentId }),
        ...(taskId && { taskId }),
        active: c.req.query('active') === '1'
      }))
    })

    .get('/runs/:id', async c => c.json(await getRun(db, c.req.param('id'))))

    .get('/runs/:id/transcript', async (c) => {
      const [row] = await db.select({ blob: schema.runs.transcriptBlob }).from(schema.runs).where(eq(schema.runs.id, c.req.param('id')))
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      return c.json(await transcripts.read(c.req.param('id'), row.blob))
    })

    .post('/runs/:id/stop', async (c) => {
      await orchestrator.stopRun(c.req.param('id'), actor)
      return c.json(await getRun(db, c.req.param('id')))
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
