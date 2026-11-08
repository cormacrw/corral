import type { CreateProjectInput, CreateTaskInput, Project, ServerEvent, Task } from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database, DatabaseHandle } from '@corral/db'
import { createTestDatabase } from '@corral/db/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { MemoryBlobStore } from './blob-store.ts'
import { boot } from './boot.ts'
import { EventBus } from './events.ts'
import { FakeGitHub } from './fake-github.ts'
import type { RunningServer } from './server.ts'
import type { Services } from './services.ts'
import { runStartHandled, type FakeRunner } from './fake-runner.ts'
import { LONGEST_POLL_MS } from './retries.ts'

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
  // Sends run.started and waits for the server to finish handling it (its
  // last step publishes run.updated). Tool calls and stops skip the per-run
  // queue, so sending one straight after run.started can land on a run
  // that is still starting.
  runStarted(runner: FakeRunner, job: { runId: string, leaseEpoch: number }, agentSessionId: string): Promise<void>
  // A merge pass after long enough that nothing is left waiting to be polled
  mergePass(): Promise<void>
  // A crash and a fresh start on the same database: the old process gets nothing
  // more into it, whatever it was doing, and all its in-memory state is gone.
  // Runners must connect again, to the new `server`.
  restart(): Promise<void>
  close(): Promise<void>
}

let counter = 0

// One process's use of the database, which ends when that process does.
// Anything it still has running fails at its next query.
function processDatabase(db: Database) {
  let dead = false
  const view = new Proxy(db, {
    get(target, key) {
      if (dead) throw new Error('This process has died')
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
  })
  return { db: view, kill: () => void (dead = true) }
}

export async function createTestApp(driver: 'pglite' | 'postgres', options: { listen?: boolean, runnerToken?: string | undefined, runnerOnly?: boolean | undefined } = {}): Promise<TestApp> {
  const handle: DatabaseHandle | null = driver === 'pglite'
    ? await createTestDatabase('pglite')
    : await createTestDatabase('postgres')
  if (!handle) throw new Error('Postgres tests need CORRAL_DATABASE_URL')

  const bus = new EventBus()
  const events: ServerEvent[] = []
  bus.subscribe(event => events.push(event))
  const spoolDir = await mkdtemp(join(tmpdir(), 'corral-spool-'))
  const github = new FakeGitHub()
  const blobs = new MemoryBlobStore()
  const clock = { now: new Date() }
  const start = async () => {
    const process = processDatabase(handle.db)
    const booted = await boot({
      db: process.db,
      events: bus,
      spoolDir,
      blobs,
      github,
      publicUrl: 'http://corral.test',
      now: () => clock.now,
      listeners: options.listen ? [{ host: '127.0.0.1', port: 0, runnerOnly: options.runnerOnly }] : [],
      runnerToken: options.runnerToken
    })
    return { process, booted, services: booted.services, server: booted.servers[0] ?? null, app: createApp(booted.deps) }
  }
  let current = await start()

  const request = async (method: string, path: string, body?: unknown) => current.app.request(path, {
    method,
    ...(body instanceof FormData
      ? { body }
      : body instanceof Blob
        ? { body: new Uint8Array(await body.arrayBuffer()), headers: { 'content-type': body.type } }
        : body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  })

  const testApp: TestApp = {
    ...current.services,
    db: handle.db,
    actor: current.booted.actor,
    events,
    bus,
    github,
    blobs,
    clock,
    server: current.server,
    request,
    async runStarted(runner, job, agentSessionId) {
      const handled = runStartHandled(bus, job.runId)
      runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId })
      await handled
    },
    mergePass() {
      clock.now = new Date(clock.now.getTime() + LONGEST_POLL_MS + 1_000)
      return current.services.orchestrator.mergePass()
    },
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
      const project = await res.json() as Project
      github.setBranch(project.repository, project.defaultBranch, 'target-tip')
      return project
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
    async restart() {
      // Flushed first: the dead process could no longer write its samples
      await current.services.performance.stop()
      current.process.kill()
      await current.booted.stop()
      current = await start()
      Object.assign(testApp, current.services, { server: current.server })
    },
    async close() {
      await current.booted.stop()
      await handle.close()
      await rm(spoolDir, { recursive: true, force: true })
    }
  }
  return testApp
}
