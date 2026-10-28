import type { CreateProjectInput, CreateTaskInput, Project, ServerEvent, Task } from '@corral/contracts'
import type { Actor } from '@corral/core'
import type { Database, DatabaseHandle } from '@corral/db'
import { createTestDatabase } from '@corral/db/testing'
import { createApp } from './app.ts'
import { EventBus } from './events.ts'
import { ensureOwner } from './owner.ts'

// A server app on a throwaway database, for tests
export interface TestApp {
  db: Database
  actor: Actor
  events: ServerEvent[]
  request(method: string, path: string, body?: unknown): Promise<Response>
  createProject(overrides?: Partial<CreateProjectInput>): Promise<Project>
  createTask(slug: string, input?: Partial<CreateTaskInput>): Promise<Task>
  close(): Promise<void>
}

let counter = 0

export async function createTestApp(driver: 'pglite' | 'postgres'): Promise<TestApp> {
  const handle: DatabaseHandle | null = driver === 'pglite'
    ? await createTestDatabase('pglite')
    : await createTestDatabase('postgres')
  if (!handle) throw new Error('Postgres tests need CORRAL_DATABASE_URL; the vitest global setup normally provides it')

  const bus = new EventBus()
  const events: ServerEvent[] = []
  bus.subscribe(event => events.push(event))
  const actor = await ensureOwner(handle.db)
  const app = createApp({ db: handle.db, events: bus, actor })

  const request = async (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  })

  return {
    db: handle.db,
    actor,
    events,
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
        type: 'backend',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Email and password' }] }] },
        acceptanceCriteria: ['Shows an error on a bad password'],
        ...input
      })
      if (res.status !== 201) throw new Error(`createTask: ${res.status} ${await res.text()}`)
      return res.json() as Promise<Task>
    },
    close: () => handle.close()
  }
}
