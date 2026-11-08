import { InboxMessages } from './inbox-message-service.ts'
import type { Database } from '@corral/db'
import { join } from 'node:path'
import type { AppDeps } from './app.ts'
import { LocalBlobStore, type BlobStore } from './blob-store.ts'
import { ReleaseNotes } from './deployments.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import { RunnerGitHub } from './runner-github.ts'
import { Orchestrator } from './orchestrator.ts'
import { PerformanceSamples } from './performance.ts'
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
  // The server's build commit, which runners are expected to run
  buildSha?: string
  slowRequestMs?: number
}

export type Services = Omit<AppDeps, 'db' | 'events' | 'actor'> & { github: GitHubClient }

// Wires the server's long-lived pieces together (boot.ts)
export function createServices(options: ServiceOptions): Services {
  const { db, events } = options
  const runner = new RunnerHub(events, options.buildSha)
  const blobs = options.blobs ?? new LocalBlobStore(options.blobDir ?? join(options.spoolDir, '..', 'blobs'))
  const transcripts = new Transcripts(options.spoolDir, blobs)
  const github = options.github ?? new RunnerGitHub(runner)
  const releaseNotes = new ReleaseNotes({ db, events, runner })
  const orchestrator = new Orchestrator({
    db,
    events,
    runner,
    github,
    blobs,
    transcripts,
    releaseNotes,
    publicUrl: options.publicUrl,
    ...(options.now && { now: options.now })
  })
  runner.setHandlers(orchestrator)
  new InboxMessages(db, events, runner)
  return { runner, orchestrator, blobs, transcripts, github, releaseNotes, performance: new PerformanceSamples(db, options.slowRequestMs) }
}
