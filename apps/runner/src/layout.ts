import type { RunJob } from '@corral/contracts'
import { errorText, UUID_SOURCE, type AgentRole } from '@corral/core'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The runner's data dir (architecture.md, Layout on disk). Each kind of folder
// has its path builder and, beside it, the pattern the sweep recognises it by.
//
//   config.json                  the runner's id (identity.ts)
//   repos/<owner>__<name>.git    one bare clone per repository
//   worktrees/<taskId>[-review]  a task's developer and reviewer checkouts
//   worktrees/epic-<epicId>[-review]
//   worktrees/pm-<projectId>-<planSessionId>  a Plan session's checkout
//   sessions/<planSessionId>     a global Plan session's folder (no checkout)
//   scratch/<runId>              a run's scratch folder
//   scratch/pm-<projectId|global>-<planSessionId>  a warm PM session's
//   spool/<runId>.jsonl          a run's raw transcript
//   turbo-cache/<projectId>      a project's shared Turbo cache

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

// A file's text, or null when there is no such file. Any other failure is
// raised: an unreadable file must not pass for a missing one.
export async function readIfExists(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new Error(`Could not read ${path}: ${errorText(error)}`, { cause: error })
  })
}

export function reposDir(dataDir: string): string {
  return join(dataDir, 'repos')
}

export function barePath(dataDir: string, repository: string): string {
  return join(reposDir(dataDir), `${repository.replace('/', '__')}.git`)
}

// The repository whose barePath a clone folder is, or null for anything else
export function cloneRepository(folder: string): string | null {
  return folder.endsWith('.git') ? folder.slice(0, -'.git'.length).replace('__', '/') : null
}

export function worktreesDir(dataDir: string): string {
  return join(dataDir, 'worktrees')
}

// What a developer or reviewer worktree belongs to: its task, or the epic of
// a run on an epic with no task (D29). Null for a job with neither.
export function workspaceKey(job: { taskId: string } | { taskId?: null | undefined, epicId: string }): string
export function workspaceKey(job: Pick<RunJob, 'taskId' | 'epicId'>): string | null
export function workspaceKey(job: { taskId?: string | null | undefined, epicId?: string | null | undefined }): string | null {
  return job.taskId ?? (job.epicId ? `epic-${job.epicId}` : null)
}

// One per task for the developer, kept between revisions, and a separate one
// at the PR commit for the reviewer (flows.md step 6)
export function worktreePath(dataDir: string, key: string, role: AgentRole): string {
  return join(worktreesDir(dataDir), role === 'reviewer' ? `${key}-review` : key)
}

// A PM checkout per Plan session (D9). It must stay put between turns:
// `claude --resume` finds a session by its working directory.
export function pmWorktreePath(dataDir: string, projectId: string, planSessionId: string): string {
  return join(worktreesDir(dataDir), `pm-${projectId}-${planSessionId}`)
}

// Ids are database UUIDs, so anything else in these folders isn't ours
const TASK_FOLDER = new RegExp(`^(${UUID_SOURCE})(-review)?$`)
const EPIC_FOLDER = new RegExp(`^epic-(${UUID_SOURCE})(-review)?$`)
const PM_FOLDER = new RegExp(`^pm-${UUID_SOURCE}-(${UUID_SOURCE})$`)

export type WorktreeFolder =
  | { kind: 'task', taskId: string, review: boolean }
  | { kind: 'epic', epicId: string, review: boolean }
  | { kind: 'pm', planSessionId: string }

export function worktreeFolder(name: string): WorktreeFolder | null {
  const task = TASK_FOLDER.exec(name)
  if (task) return { kind: 'task', taskId: task[1]!, review: task[2] !== undefined }
  const epic = EPIC_FOLDER.exec(name)
  if (epic) return { kind: 'epic', epicId: epic[1]!, review: epic[2] !== undefined }
  const pm = PM_FOLDER.exec(name)
  return pm ? { kind: 'pm', planSessionId: pm[1]! } : null
}

// Review and PM checkouts are read-only by contract, so changes left in them are
// discarded. A developer's uncommitted work stays (PRD §7.4), on a task or an epic.
export function discardsChanges(folder: WorktreeFolder): boolean {
  return folder.kind === 'pm' || folder.review
}

export function sessionsDir(dataDir: string): string {
  return join(dataDir, 'sessions')
}

// A global Plan session works in a plain folder (D30)
export function globalSessionPath(dataDir: string, planSessionId: string): string {
  return join(sessionsDir(dataDir), planSessionId)
}

const SESSION_FOLDER = new RegExp(`^(${UUID_SOURCE})$`)

export function sessionFolder(name: string): string | null {
  return SESSION_FOLDER.exec(name)?.[1] ?? null
}

export function scratchDir(dataDir: string): string {
  return join(dataDir, 'scratch')
}

// A warm process's system prompt names its scratch folder, so a warm PM
// session's is the session's, not each run's
export function scratchPath(dataDir: string, job: Pick<RunJob, 'runId' | 'projectId' | 'planSessionId'>, warm: boolean): string {
  return join(scratchDir(dataDir), warm ? `pm-${job.projectId ?? 'global'}-${job.planSessionId}` : job.runId)
}

const RUN_SCRATCH = new RegExp(`^(${UUID_SOURCE})$`)
// `null` is what runners before `global` named a global session's
const SESSION_SCRATCH = new RegExp(`^pm-(?:${UUID_SOURCE}|global|null)-(${UUID_SOURCE})$`)

type ScratchFolder = { kind: 'run', runId: string } | { kind: 'session', planSessionId: string }

export function scratchFolder(name: string): ScratchFolder | null {
  const session = SESSION_SCRATCH.exec(name)
  if (session) return { kind: 'session', planSessionId: session[1]! }
  const run = RUN_SCRATCH.exec(name)
  return run ? { kind: 'run', runId: run[1]! } : null
}

export function spoolDir(dataDir: string): string {
  return join(dataDir, 'spool')
}

export function spoolPath(dataDir: string, runId: string): string {
  return join(spoolDir(dataDir), `${runId}.jsonl`)
}

const RUN_SPOOL = new RegExp(`^(${UUID_SOURCE})\\.jsonl$`)

export function spoolFile(name: string): string | null {
  return RUN_SPOOL.exec(name)?.[1] ?? null
}

export function turboCacheDir(dataDir: string): string {
  return join(dataDir, 'turbo-cache')
}

// One Turbo cache per project on this runner, shared by its worktrees, so a
// new task's unchanged packages replay lint, typecheck and build. Keyed by
// project, so one project's entries never replay in another
// (.corral/wiki/turbo-cache.md).
export function turboCachePath(dataDir: string, projectId: string): string {
  return join(turboCacheDir(dataDir), projectId)
}
