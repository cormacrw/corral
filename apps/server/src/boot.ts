import type { Actor } from '@corral/core'
import type { AppDeps } from './app.ts'
import { ensureAgents, ensureOwner } from './bootstrap.ts'
import { startServer, type RunningServer } from './server.ts'
import { createServices, type ServiceOptions, type Services } from './services.ts'

interface BootOptions extends ServiceOptions {
  // A runner-only listener never mounts the API (D25)
  listeners?: { host: string, port: number, runnerOnly?: boolean | undefined }[]
  runnerToken?: string | undefined
  // The orchestrator's timers. Tests and the demo seed run passes themselves.
  start?: boolean
}

export interface Booted {
  deps: AppDeps
  services: Services
  actor: Actor
  servers: RunningServer[]
  // Everything but the database, which the caller opened
  stop(): Promise<void>
}

// Starting the server, the same way for the real one (index.ts), tests
// (test-app.ts) and the demo seed (demo/harness.ts)
export async function boot(options: BootOptions): Promise<Booted> {
  const { listeners = [], runnerToken, start = false, ...serviceOptions } = options
  await ensureAgents(options.db)
  const actor = await ensureOwner(options.db)
  const services = createServices(serviceOptions)
  const deps: AppDeps = { db: options.db, events: options.events, actor, ...services }
  // Before the listeners: a runner connecting sooner could start work while
  // Corral is stopped
  await services.orchestrator.init()
  const servers: RunningServer[] = []
  for (const listener of listeners) servers.push(await startServer(deps, { ...listener, runnerToken }))
  if (start) services.orchestrator.start()
  return {
    deps,
    services,
    actor,
    servers,
    async stop() {
      services.orchestrator.stop()
      await Promise.all(servers.map(server => server.close()))
      await services.performance.stop()
    }
  }
}
