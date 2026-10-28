import type { RunJob } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './exec.ts'
import { barePath, syncRepository } from './repos.ts'
import { DEFAULT_ROLE_INSTRUCTIONS } from './role-defaults.ts'

// Worktrees under <dataDir>/worktrees (architecture.md, Layout on disk):
// one per task for the developer, kept between revisions, and a separate
// one at the PR commit for the reviewer (flows.md step 6)
export function worktreePath(dataDir: string, taskId: string, role: AgentRole): string {
  return join(dataDir, 'worktrees', role === 'reviewer' ? `${taskId}-review` : taskId)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

export interface Workspace {
  path: string
  bare: string
}

// Fetches the bare clone and creates or reuses the worktree for this run.
// Returns an error message instead of throwing, so the run can fail cleanly.
export async function prepareWorkspace(dataDir: string, job: RunJob): Promise<{ workspace: Workspace, error: null } | { workspace: null, error: string }> {
  const syncError = await syncRepository(dataDir, job.repository)
  if (syncError) return { workspace: null, error: `Could not fetch ${job.repository}: ${syncError}` }
  const bare = barePath(dataDir, job.repository)
  // Forget worktrees whose folders were removed by hand
  await git(['worktree', 'prune'], { cwd: bare })

  if (job.role === 'pm') {
    // A read-only checkout of the default branch (D9), shared by every PM turn
    const path = join(dataDir, 'worktrees', `pm-${job.projectId}`)
    const result = await exists(path)
      ? await git(['checkout', '--detach', '--force', `origin/${job.defaultBranch}`], { cwd: path })
      : await git(['worktree', 'add', '--detach', path, `origin/${job.defaultBranch}`], { cwd: bare })
    if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
    return { workspace: { path, bare }, error: null }
  }

  if (!job.taskId || !job.branch) return { workspace: null, error: 'The job has no task or branch' }
  const path = worktreePath(dataDir, job.taskId, job.role)

  if (job.role === 'reviewer') {
    // The reviewer looks at exactly the commit the developer submitted
    if (!job.headSha) return { workspace: null, error: 'The job has no commit to review' }
    const result = await exists(path)
      ? await git(['checkout', '--detach', '--force', job.headSha], { cwd: path })
      : await git(['worktree', 'add', '--detach', path, job.headSha], { cwd: bare })
    if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
    return { workspace: { path, bare }, error: null }
  }

  // Developer: reuse the worktree between revisions (D10) so uncommitted
  // work is never lost; otherwise start the branch from origin
  if (await exists(path)) return { workspace: { path, bare }, error: null }
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${job.branch}`], { cwd: bare })
  const start = remote.code === 0 ? `origin/${job.branch}` : `origin/${job.defaultBranch}`
  const result = await git(['worktree', 'add', path, '-B', job.branch, start], { cwd: bare })
  if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
  return { workspace: { path, bare }, error: null }
}

// Role instructions live in the repo so each project can set its own rules
// (D13); the built-in text applies when the file is missing
export async function readRoleInstructions(worktree: string, role: AgentRole): Promise<string> {
  const text = await readFile(join(worktree, '.corral', 'agents', `${role}.md`), 'utf8').catch(() => null)
  return text?.trim() || DEFAULT_ROLE_INSTRUCTIONS[role] || ''
}

export async function headSha(worktree: string): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], { cwd: worktree })
  return result.code === 0 ? result.stdout.trim() : null
}

// The runner is the only thing that pushes, and only to the branch the run
// holds a lease for (D8). Returns the pushed commit.
export async function pushBranch(worktree: string, branch: string): Promise<{ sha: string, error: null } | { sha: null, error: string }> {
  const sha = await headSha(worktree)
  if (!sha) return { sha: null, error: 'The worktree has no commits' }
  const push = await git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree, timeoutMs: 5 * 60_000 })
  if (push.code !== 0) return { sha: null, error: push.stderr.trim() || 'git push failed' }
  return { sha, error: null }
}

export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  const status = await git(['status', '--porcelain'], { cwd: worktree })
  return status.code !== 0 || status.stdout.trim().length > 0
}

// Removes a worktree unless it holds uncommitted work (PRD §7.4). Returns
// whether it was removed.
export async function removeWorktree(bare: string, path: string, force = false): Promise<boolean> {
  if (!(await exists(path))) {
    await git(['worktree', 'prune'], { cwd: bare })
    return true
  }
  if (!force && await hasUncommittedChanges(path)) return false
  const result = await git(['worktree', 'remove', '--force', path], { cwd: bare })
  if (result.code !== 0) await rm(path, { recursive: true, force: true })
  await git(['worktree', 'prune'], { cwd: bare })
  return true
}
