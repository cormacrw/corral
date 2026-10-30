import type { CreateDeploymentInput, Deployment } from '@corral/contracts'
import { richTextToMarkdown, taskRef, type TaskType } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'
import { releaseNotesPrompt } from './prompts.ts'
import { RunnerDisconnected, type RunnerHub } from './runner-hub.ts'

const { agents, deployments, projects, tasks } = schema

// The runner gives the CLI two minutes; this covers the round trip
const NOTES_TIMEOUT_MS = 130_000

const TYPE_HEADINGS: Record<TaskType, string> = { task: 'Tasks', bug: 'Bugs', spike: 'Spikes', design: 'Designs' }

type DeploymentRow = typeof deployments.$inferSelect

interface ShippedTask {
  ref: string
  type: TaskType
  title: string
  description: string
}

interface Changes {
  tasks: ShippedTask[]
  // Subjects of the commits that match no task
  commits: string[]
}

function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    projectId: row.projectId,
    fromSha: row.fromSha,
    toSha: row.toSha,
    commits: row.commits,
    notes: row.notes,
    notesStatus: row.notesStatus,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  }
}

// Records what a deploy shipped (D16). The project is found by its GitHub
// repository, ignoring case as GitHub does. A toSha already recorded for the
// project returns that record unchanged, so the deploy script can retry.
export async function recordDeployment(db: Executor, input: CreateDeploymentInput): Promise<{ deployment: Deployment, created: boolean }> {
  const [project] = await db.select({ id: projects.id }).from(projects)
    .where(sql`lower(${projects.repository}) = ${input.repository.toLowerCase()}`)
  if (!project) throw new ApiFailure(404, { code: 'not_found' })
  const [inserted] = await db.insert(deployments)
    .values({ projectId: project.id, fromSha: input.fromSha, toSha: input.toSha, commits: input.commits })
    .onConflictDoNothing({ target: [deployments.projectId, deployments.toSha] })
    .returning()
  if (inserted) return { deployment: toDeployment(inserted), created: true }
  const [existing] = await db.select().from(deployments)
    .where(and(eq(deployments.projectId, project.id), eq(deployments.toSha, input.toSha)))
  return { deployment: toDeployment(existing!), created: false }
}

export interface ReleaseNotesDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
}

// Writes the release notes of pending deployments, one at a time and oldest
// first (D11). Each is a setup job, not a run, so it holds no PM slot. A
// deployment stays pending while no runner can take the job; `sweep` runs
// again when one connects, which also covers a server restart.
export class ReleaseNotes {
  #d: ReleaseNotesDeps
  #sweeping = false
  #again = false

  constructor(deps: ReleaseNotesDeps) {
    this.#d = deps
  }

  // Never rejects. A call during a sweep makes that sweep look again.
  async sweep(): Promise<void> {
    this.#again = true
    if (this.#sweeping) return
    this.#sweeping = true
    try {
      while (this.#again) {
        this.#again = false
        await this.#drain()
      }
    } catch (error) {
      console.error('Writing release notes failed', error)
    } finally {
      this.#sweeping = false
    }
  }

  async #drain(): Promise<void> {
    const { db, runner } = this.#d
    const [pm] = await db.select({ runtime: agents.runtime }).from(agents).where(eq(agents.role, 'pm')).limit(1)
    const runtime = pm?.runtime ?? 'claude-code'
    while (runner.pick(runtime)) {
      const [row] = await db.select().from(deployments).where(eq(deployments.notesStatus, 'pending')).orderBy(asc(deployments.createdAt)).limit(1)
      if (!row) return
      await this.#write(row, runtime)
    }
  }

  async #write(row: DeploymentRow, runtime: string): Promise<void> {
    const changes = await this.#changes(row)
    if (changes.tasks.length === 0 && changes.commits.length === 0) return this.#save(row.id, 'No changes were listed for this deployment.', 'ready')
    const [project] = await this.#d.db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId))
    if (!project) return
    let answer: string
    try {
      const result = await this.#d.runner.request({ kind: 'release_notes', runtime, prompt: releaseNotesPrompt({ projectName: project.name, ...changes }) }, NOTES_TIMEOUT_MS)
      answer = result.notes.trim()
      if (!answer) throw new Error('Empty release notes')
    } catch (error) {
      // No answer is coming from a runner that went away: stays pending
      if (error instanceof RunnerDisconnected || error instanceof ApiFailure) return
      console.error(`Release notes for deployment ${row.id} failed; using the plain list`, error instanceof Error ? error.message : error)
      return this.#save(row.id, fallbackNotes(changes), 'failed')
    }
    return this.#save(row.id, withEveryChange(answer, changes), 'ready')
  }

  // Each commit is a task's merge commit in this project, or stays a subject
  async #changes(row: DeploymentRow): Promise<Changes> {
    const { db } = this.#d
    const shas = row.commits.map(c => c.sha)
    const matched = shas.length === 0
      ? []
      : await db.select({ task: tasks, prefix: projects.prefix }).from(tasks).innerJoin(projects, eq(tasks.projectId, projects.id))
          .where(and(eq(tasks.projectId, row.projectId), inArray(tasks.mergeCommitSha, shas), isNull(tasks.deletedAt)))
          .orderBy(asc(tasks.number))
    const merged = new Set(matched.map(m => m.task.mergeCommitSha))
    return {
      tasks: matched.map(({ task, prefix }) => ({ ref: taskRef(prefix, task.number), type: task.type, title: task.title, description: richTextToMarkdown(task.description) })),
      commits: row.commits.filter(c => !merged.has(c.sha)).map(c => c.subject)
    }
  }

  async #save(id: string, notes: string, notesStatus: 'ready' | 'failed'): Promise<void> {
    const [updated] = await this.#d.db.update(deployments).set({ notes, notesStatus })
      .where(and(eq(deployments.id, id), eq(deployments.notesStatus, 'pending'))).returning()
    if (updated) this.#d.events.publish({ type: 'deployment.updated', deployment: toDeployment(updated) })
  }
}

// The plain list when the model can't write the notes
export function fallbackNotes(changes: Changes): string {
  const types = Object.keys(TYPE_HEADINGS) as TaskType[]
  const groups = types.map((type) => {
    const lines = changes.tasks.filter(t => t.type === type).map(t => `- ${t.ref} ${t.title}`)
    return lines.length ? `## ${TYPE_HEADINGS[type]}\n\n${lines.join('\n')}` : ''
  })
  const commits = changes.commits.length ? `## Other commits\n\n${changes.commits.map(subject => `- ${subject}`).join('\n')}` : ''
  return [...groups, commits].filter(Boolean).join('\n\n')
}

// A task or commit the model left out is added at the end, so the notes
// always cover everything that shipped
export function withEveryChange(notes: string, changes: Changes): string {
  const missing = [
    ...changes.tasks.filter(t => !new RegExp(`\\b${t.ref}\\b`).test(notes)).map(t => `- ${t.title} (${t.ref})`),
    ...changes.commits.filter(subject => !notes.includes(subject)).map(subject => `- ${subject}`)
  ]
  return missing.length ? `${notes}\n\n## Also in this deployment\n\n${missing.join('\n')}` : notes
}
