import { InboxMessages } from './inbox-message-service.ts'
import type { Database } from '@corral/db'
import { join } from 'node:path'
import type { AppDeps } from './app.ts'
import { LocalBlobStore, type BlobStore } from './blob-store.ts'
import { ReleaseNotes } from './deployments.ts'
import type { EventBus } from './events.ts'
import { RunnerGitHub, type GitHubClient } from './github.ts'
import { Orchestrator } from './orchestrator.ts'
import { PerformanceSamples } from './performance.ts'
import { PlanService } from './plan.ts'
import { RunnerHub } from './runner-hub.ts'
import { Transcripts } from './transcripts.ts'

export interface ServiceOptions {
  db: Database
  events: EventBus
  // Where transcripts are spooled while a run is live
  spoolDir: string
  // Blobs under <dataDir>/blobs unless a store is given (tests use MemoryBlobStore)
  blobs?: BlobStore
  blobDir?: string
  // Tests pass FakeGitHub; the real one calls GitHub through the runner (R15)
  github?: GitHubClient
  publicUrl: string
  now?: () => Date
}

export type Services = Omit<AppDeps, 'db' | 'events' | 'actor'> & { github: GitHubClient, plans: PlanService }

// Wires the server's long-lived pieces together, the same way for the real
// server and for tests, so the two never drift apart
export function createServices(options: ServiceOptions): Services {
  const { db, events } = options
  const runner = new RunnerHub(events)
  const blobs = options.blobs ?? new LocalBlobStore(options.blobDir ?? join(options.spoolDir, '..', 'blobs'))
  const transcripts = new Transcripts(options.spoolDir, blobs)
  const github = options.github ?? new RunnerGitHub(runner)
  const orchestrator = new Orchestrator({
    db,
    events,
    runner,
    github,
    blobs,
    transcripts,
    publicUrl: options.publicUrl,
    ...(options.now && { now: options.now })
  })
  runner.setHandlers(orchestrator)
  const plans = new PlanService({ db, events, runner, stopRun: (runId, actor) => orchestrator.stopRun(runId, actor), startRun: (session, job) => orchestrator.startPmRun(session, job) })
  orchestrator.plans = plans
  new InboxMessages(db, events, runner)
  const releaseNotes = new ReleaseNotes({ db, events, runner })
  orchestrator.releaseNotes = releaseNotes
  return { runner, orchestrator, blobs, transcripts, github, plans, releaseNotes, performance: new PerformanceSamples(db) }
}
