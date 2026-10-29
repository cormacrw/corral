import type { CreateProjectInput, CreateTaskInput, Project, ServerEvent, Task } from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database, DatabaseHandle } from '@corral/db'
import { createTestDatabase } from '@corral/db/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { MemoryBlobStore } from './blob-store.ts'
import { ensureAgents, ensureOwner } from './bootstrap.ts'
import { EventBus } from './events.ts'
import { FakeGitHub } from './fake-github.ts'
import { startServer, type RunningServer } from './server.ts'
import { createServices, type Services } from './services.ts'

// A server app on a throwaway database, for tests
export interface TestApp extends Services {
  db: Database
  actor: Actor
  events: ServerEvent[]
  bus: EventBus
  github: FakeGitHub
  blobs: MemoryBlobStore
  // The test clock: tests move it to expire leases
  clock: { now: Date }
  // Set when the test asked for a listening server (runner WebSocket tests)
  server: RunningServer | null
  // JSON by default; a Blob is sent as is, with its type (file uploads)
  request(method: string, path: string, body?: unknown): Promise<Response>
  createProject(overrides?: Partial<CreateProjectInput>): Promise<Project>
  createTask(slug: string, input?: Partial<CreateTaskInput>): Promise<Task>
  close(): Promise<void>
}

let counter = 0

export async function createTestApp(driver: 'pglite' | 'postgres', options: { listen?: boolean } = {}): Promise<TestApp> {
  const handle: DatabaseHandle | null = driver === 'pglite'
    ? await createTestDatabase('pglite')
    : await createTestDatabase('postgres')
  if (!handle) throw new Error('Postgres tests need CORRAL_DATABASE_URL; the vitest global setup normally provides it')

  const bus = new EventBus()
  const events: ServerEvent[] = []
  bus.subscribe(event => events.push(event))
  const actor = await ensureOwner(handle.db)
  await ensureAgents(handle.db)
  const spoolDir = await mkdtemp(join(tmpdir(), 'corral-spool-'))
  const github = new FakeGitHub()
  const blobs = new MemoryBlobStore()
  const clock = { now: new Date() }
  const services = createServices({ db: handle.db, events: bus, spoolDir, blobs, github, publicUrl: 'http://corral.test', now: () => clock.now })
  await services.orchestrator.init()
  const deps = { db: handle.db, events: bus, actor, ...services }
  const app = createApp(deps)
  const server = options.listen ? await startServer(deps, { host: '127.0.0.1', port: 0 }) : null

  const request = async (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    ...(body instanceof FormData
      ? { body }
      : body instanceof Blob
        ? { body: new Uint8Array(await body.arrayBuffer()), headers: { 'content-type': body.type } }
        : body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  })

  return {
    ...services,
    db: handle.db,
    actor,
    events,
    bus,
    github,
    blobs,
    clock,
    server,
    request,
    async createProject(overrides = {}) {
      counter++
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      const res = await request('POST', '/api/projects', {
        name: `Project ${counter}`,
        prefix: `T${letters[counter % 26]}${letters[Math.floor(counter / 26) % 26]}`,
        repository: `owner/repo-${counter}`,
        defaultBranch: 'main',
        ...overrides
      })
      if (res.status !== 201) throw new Error(`createProject: ${res.status} ${await res.text()}`)
      return res.json() as Promise<Project>
    },
    async createTask(slug, input = {}) {
      const res = await request('POST', `/api/projects/${slug}/tasks`, {
        title: 'Add login',
        type: 'task',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Email and password' }] }] },
        acceptanceCriteria: ['Shows an error on a bad password'],
        ...input
      })
      if (res.status !== 201) throw new Error(`createTask: ${res.status} ${await res.text()}`)
      return res.json() as Promise<Task>
    },
    async close() {
      services.orchestrator.stop()
      await server?.close()
      await handle.close()
      await rm(spoolDir, { recursive: true, force: true })
    }
  }
}
