import type { RunJob } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { GitAuthor } from './config.ts'
import { git } from './exec.ts'
import { barePath, syncRepository, withRepoLock } from './repos.ts'
import { DEFAULT_ROLE_INSTRUCTIONS } from './role-defaults.ts'

// Worktrees under <dataDir>/worktrees (architecture.md, Layout on disk):
// one per task for the developer, kept between revisions, and a separate
// one at the PR commit for the reviewer (flows.md step 6)
export function worktreePath(dataDir: string, taskId: string, role: AgentRole): string {
  return join(dataDir, 'worktrees', role === 'reviewer' ? `${taskId}-review` : taskId)
}

// A PM checkout per Plan session (D9). It must stay put between turns:
// `claude --resume` finds a session by its working directory.
export function pmWorktreePath(dataDir: string, projectId: string, planSessionId: string): string {
  return join(dataDir, 'worktrees', `pm-${projectId}-${planSessionId}`)
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
  // Adding worktrees writes to the bare clone too, so it takes the same lock
  return withRepoLock(bare, () => checkOut(dataDir, bare, job))
}

async function checkOut(dataDir: string, bare: string, job: RunJob): Promise<{ workspace: Workspace, error: null } | { workspace: null, error: string }> {
  // Forget worktrees whose folders were removed by hand
  await git(['worktree', 'prune'], { cwd: bare })

  if (job.role === 'pm') {
    // A read-only checkout of the default branch (D9), one per Plan session
    if (!job.planSessionId) return { workspace: null, error: 'The job has no plan session' }
    const path = pmWorktreePath(dataDir, job.projectId, job.planSessionId)
    const result = await exists(path)
      ? await git(['checkout', '--detach', '--force', `origin/${job.defaultBranch}`], { cwd: path })
      : await git(['worktree', 'add', '--detach', path, `origin/${job.defaultBranch}`], { cwd: bare })
    if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
    return { workspace: { path, bare }, error: null }
  }

  const workId = job.taskId ?? (job.role === 'reviewer' && job.epicId ? `epic-${job.epicId}` : null)
  if (!workId) return { workspace: null, error: 'The job has no task' }
  const path = worktreePath(dataDir, workId, job.role)

  // A spike has no branch or commit (D19): both its developer and its
  // reviewer get a detached checkout of the default branch. The developer's
  // is kept between revisions, like any developer worktree.
  if (!job.branch) {
    if (job.role === 'developer' && await exists(path)) return { workspace: { path, bare }, error: null }
    const start = `origin/${job.defaultBranch}`
    const result = await exists(path)
      ? await git(['checkout', '--detach', '--force', start], { cwd: path })
      : await git(['worktree', 'add', '--detach', path, start], { cwd: bare })
    if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
    return { workspace: { path, bare }, error: null }
  }

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
  if (await exists(path)) {
    const error = job.continueFrom ? await catchUp(path, job.continueFrom) : null
    return error ? { workspace: null, error } : { workspace: { path, bare }, error: null }
  }
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${job.branch}`], { cwd: bare })
  const start = remote.code === 0 ? `origin/${job.branch}` : `origin/${job.baseBranch ?? job.defaultBranch}`
  const result = await git(['worktree', 'add', path, '-B', job.branch, start], { cwd: bare })
  if (result.code !== 0) return { workspace: null, error: result.stderr.trim() || 'git worktree add failed' }
  return { workspace: { path, bare }, error: null }
}

// A worktree kept from an earlier run can be behind the WIP commit a stopped
// run pushed from another runner. It moves forward only: anything else would
// drop commits, or the WIP commit on the next push.
async function catchUp(path: string, sha: string): Promise<string | null> {
  const contains = await git(['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: path })
  if (contains.code === 0) return null
  const forward = await git(['merge', '--ff-only', sha], { cwd: path })
  if (forward.code === 0) return null
  return `Could not continue from WIP commit ${sha}: ${forward.stderr.trim() || 'git merge failed'}`
}

// Role instructions live in the repo so each project can set its own rules
// (D13); the built-in text applies when the file is missing
export async function readRoleInstructions(worktree: string, role: AgentRole): Promise<string> {
  const text = await readFile(join(worktree, '.corral', 'agents', `${role}.md`), 'utf8').catch(() => null)
  return text?.trim() || DEFAULT_ROLE_INSTRUCTIONS[role] || ''
}

// Every role's project brief, so a first turn doesn't spend model calls finding
// the top-level docs. Searched in this order; the first that exists wins.
const BRIEF_FILES = ['CORRAL.md', join('.corral', 'CORRAL.md'), 'CLAUDE.md']
export const MAX_BRIEF_CHARS = 20_000

async function wikiPages(worktree: string): Promise<string[]> {
  const wiki = join(worktree, '.corral', 'wiki')
  const entries = await readdir(wiki, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(wiki, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

// Always includes worktree status, even when no project docs exist.
export async function readProjectBrief(worktree: string): Promise<string> {
  let doc: { name: string, text: string } | null = null
  for (const name of BRIEF_FILES) {
    const text = await readFile(join(worktree, name), 'utf8').catch(() => null)
    if (text?.trim()) {
      doc = { name: name.split(sep).join('/'), text: text.trim() }
      break
    }
  }
  const pages = await wikiPages(worktree)
  const [hasWiki, hasDependencies] = await Promise.all([
    stat(join(worktree, '.corral', 'wiki')).then(s => s.isDirectory(), () => false),
    stat(join(worktree, 'node_modules')).then(s => s.isDirectory(), () => false)
  ])

  const parts: string[] = []
  if (doc) parts.push(`### ${doc.name}`, '', doc.text, '')
  if (pages.length > 0) parts.push('### Wiki pages in .corral/wiki/', '', ...pages.map(page => `- ${page}`), '')
  let body = parts.join('\n').trim()
  if (body.length > MAX_BRIEF_CHARS) {
    body = `${body.slice(0, MAX_BRIEF_CHARS)}\n\n[Brief truncated: it is longer than ${MAX_BRIEF_CHARS.toLocaleString('en')} characters. Read ${doc ? doc.name : 'the files above'} for the rest if you need it.]`
  }
  const listed = [doc?.name, pages.length > 0 ? 'the .corral/wiki/ file list' : null].filter(Boolean).join(' and ')
  return [
    '## Project brief',
    '',
    `Worktree status: .corral/wiki/ ${hasWiki ? 'exists' : 'does not exist'}; dependencies (node_modules) are ${hasDependencies ? 'installed' : 'not installed'} in this worktree.`,
    '',
    listed ? `The runner has already read ${listed} from your checkout and included it below, so don't read ${doc ? 'that file' : 'it'} again. Open other files, including individual wiki pages, only when a request needs them.` : 'No project brief file (CORRAL.md, .corral/CORRAL.md or CLAUDE.md) was found.',
    '',
    body
  ].join('\n')
}

export async function headSha(worktree: string): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], { cwd: worktree })
  return result.code === 0 ? result.stdout.trim() : null
}

// The runner is the only thing that pushes, and only to the branch the run
// holds a lease for (D8). Returns the pushed commit.
export async function pushBranch(worktree: string, branch: string, timeoutMs = 5 * 60_000): Promise<{ sha: string, error: null } | { sha: null, error: string }> {
  const sha = await headSha(worktree)
  if (!sha) return { sha: null, error: 'The worktree has no commits' }
  const push = await git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree, timeoutMs })
  if (push.code !== 0) return { sha: null, error: push.stderr.trim() || 'git push failed' }
  return { sha, error: null }
}

const WIP_AUTHOR: GitAuthor = { name: 'Corral', email: 'corral@localhost' }

export interface SavedWork {
  // The WIP commit; null when there was nothing to save or it couldn't be made
  sha: string | null
  pushed: boolean
  error: string | null
}

// Commits whatever a stopped run left in its worktree and pushes the branch,
// all within timeoutMs. A clean worktree pushes nothing. The agent has exited
// by now, so a lock it left behind is stale. A commit that can't be pushed
// stays in the worktree, which the next run on this runner reuses.
export async function saveStoppedWork(worktree: string, branch: string, message: string, gitAuthor: GitAuthor | null, timeoutMs: number): Promise<SavedWork> {
  const failed = (error: string): SavedWork => ({ sha: null, pushed: false, error })
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(deadline - Date.now(), 1)
  const options = () => ({ cwd: worktree, timeoutMs: remaining() })

  if (!(await hasUncommittedChanges(worktree))) return { sha: null, pushed: false, error: null }
  // In a rebase HEAD is a half-replayed commit, not the task branch
  const head = await git(['symbolic-ref', '--quiet', 'HEAD'], options())
  if (head.stdout.trim() !== `refs/heads/${branch}`) return failed(`the worktree is not on ${branch}`)

  const lock = await git(['rev-parse', '--git-path', 'index.lock'], options())
  if (lock.code === 0) await rm(resolve(worktree, lock.stdout.trim()), { force: true })
  const added = await git(['add', '--all'], options())
  if (added.code !== 0) return failed(added.stderr.trim() || 'git add failed')
  // A runner with no identity of its own still has to save the work
  const configured = gitAuthor ?? ((await git(['config', 'user.email'], options())).code === 0 ? null : WIP_AUTHOR)
  const identity = configured
    ? { GIT_AUTHOR_NAME: configured.name, GIT_AUTHOR_EMAIL: configured.email, GIT_COMMITTER_NAME: configured.name, GIT_COMMITTER_EMAIL: configured.email }
    : {}
  // Hooks are for finished work, and this work may not even build
  const committed = await git(['commit', '--no-verify', '--quiet', '--message', message], { ...options(), env: identity })
  if (committed.code !== 0) return failed(committed.stderr.trim() || committed.stdout.trim() || 'git commit failed')

  const pushed = await pushBranch(worktree, branch, remaining())
  if (pushed.sha === null) return { sha: await headSha(worktree), pushed: false, error: pushed.error }
  return { sha: pushed.sha, pushed: true, error: null }
}

export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  const status = await git(['status', '--porcelain'], { cwd: worktree })
  return status.code !== 0 || status.stdout.trim().length > 0
}

// Removes a worktree unless it holds uncommitted work (PRD §7.4). Returns
// whether it was removed.
export function removeWorktree(bare: string, path: string, force = false): Promise<boolean> {
  return withRepoLock(bare, async () => {
    if (!(await exists(path))) {
      await git(['worktree', 'prune'], { cwd: bare })
      return true
    }
    if (!force && await hasUncommittedChanges(path)) return false
    const result = await git(['worktree', 'remove', '--force', path], { cwd: bare })
    if (result.code !== 0) await rm(path, { recursive: true, force: true })
    await git(['worktree', 'prune'], { cwd: bare })
    return true
  })
}
