import { isGlobalPmJob, type RunJob } from '@corral/contracts'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PUSH_TIMEOUT_MS } from './budgets.ts'
import { FALLBACK_COMMITTER, type GitAuthor } from './config.ts'
import { git } from './exec.ts'
import { exists, globalSessionPath, pmWorktreePath, workspaceKey, worktreePath } from './layout.ts'
import { openRepo, remoteRef, type Repo } from './repos.ts'

// The checkouts agents work in, and the git work on them the runner does itself

interface Workspace {
  path: string
  bare: string | null
}

// Returns an error message instead of throwing, so the run can fail cleanly.
export async function prepareWorkspace(dataDir: string, job: RunJob): Promise<Prepared> {
  if (isGlobalPmJob(job)) {
    if (!job.planSessionId) return { workspace: null, error: 'The job has no plan session' }
    const path = globalSessionPath(dataDir, job.planSessionId)
    await mkdir(path, { recursive: true })
    return { workspace: { path, bare: null }, error: null }
  }
  const repo = openRepo(dataDir, job.repository)
  const syncError = await repo.sync()
  if (syncError) return { workspace: null, error: `Could not fetch ${job.repository}: ${syncError}` }
  // Adding worktrees writes to the bare clone too, so it takes the same lock
  return repo.withLock(() => checkOut(dataDir, repo, job))
}

type Prepared = { workspace: Workspace, error: null } | { workspace: null, error: string }

// A checkout of a large repository under load can take minutes
const CHECKOUT_TIMEOUT_MS = 10 * 60_000

async function checkOut(dataDir: string, repo: Repo, job: RunJob): Promise<Prepared> {
  const bare = repo.bare
  // Forget worktrees whose folders were removed by hand
  await git(['worktree', 'prune'], { cwd: bare })
  const prepared = (path: string, error: string | null): Prepared => error ? { workspace: null, error } : { workspace: { path, bare }, error: null }

  if (job.role === 'pm') {
    // A read-only checkout of the default branch (D9), one per Plan session
    if (!job.planSessionId) return { workspace: null, error: 'The job has no plan session' }
    const path = pmWorktreePath(dataDir, job.projectId!, job.planSessionId)
    return prepared(path, await checkoutOrAdd(bare, path, `origin/${job.defaultBranch}`))
  }

  const workId = workspaceKey(job)
  if (!workId) return { workspace: null, error: 'The job has no task' }
  const path = worktreePath(dataDir, workId, job.role)

  // A spike has no branch or commit (D19): both its developer and its
  // reviewer get a detached checkout of the default branch. The developer's
  // is kept between revisions, like any developer worktree.
  if (!job.branch) {
    if (job.role === 'developer' && await keptWorktree(bare, path)) return prepared(path, null)
    return prepared(path, await checkoutOrAdd(bare, path, `origin/${job.defaultBranch}`))
  }

  if (job.role === 'reviewer') {
    // The reviewer looks at exactly the commit the developer submitted
    if (!job.headSha) return { workspace: null, error: 'The job has no commit to review' }
    return prepared(path, await checkoutOrAdd(bare, path, job.headSha))
  }

  // A developer on an epic works one operation's candidate at a time, and a
  // later operation's is another branch
  if (job.taskId === null && await keptWorktree(bare, path) && (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })).stdout.trim() !== job.branch) await discardWorktree(bare, path)

  // Developer: reuse the worktree between revisions (D10) so uncommitted
  // work is never lost; otherwise start the branch from origin
  if (await keptWorktree(bare, path)) return prepared(path, job.continueFrom ? await catchUp(path, job.continueFrom) : null)
  const start = await repo.revParse(remoteRef(job.branch)) ? `origin/${job.branch}` : `origin/${job.baseBranch ?? job.defaultBranch}`
  return prepared(path, await addWorktree(bare, path, [path, '-B', job.branch, start]))
}

// A read-only checkout at `ref`, reusing the worktree that's there. Returns an
// error message or null.
async function checkoutOrAdd(bare: string, path: string, ref: string): Promise<string | null> {
  if (!(await keptWorktree(bare, path))) return addWorktree(bare, path, ['--detach', path, ref])
  const result = await git(['checkout', '--detach', '--force', ref], { cwd: path, timeoutMs: CHECKOUT_TIMEOUT_MS })
  return result.code === 0 ? null : result.stderr.trim() || 'git worktree add failed'
}

async function addWorktree(bare: string, path: string, args: string[]): Promise<string | null> {
  const result = await git(['worktree', 'add', ...args], { cwd: bare, timeoutMs: CHECKOUT_TIMEOUT_MS })
  if (result.code === 0) return null
  // Half a checkout must not pass for a kept worktree next time
  await discardWorktree(bare, path)
  return result.stderr.trim() || 'git worktree add failed'
}

// Whether the folder is a worktree to reuse. One `git worktree add` never
// finished is discarded: the agent would miss files, and a WIP commit would
// record them as deleted.
async function keptWorktree(bare: string, path: string): Promise<boolean> {
  if (!(await exists(path))) return false
  if (!(await unfinishedWorktree(path))) return true
  await discardWorktree(bare, path)
  return false
}

// `git worktree add` locks a worktree with this reason until it has finished
// checking out. Anything it can't vouch for counts as finished, so a working
// tree that might hold uncommitted changes is never removed by mistake: a
// timeout says nothing, and neither does a lock someone took on purpose.
async function unfinishedWorktree(path: string): Promise<boolean> {
  if (!(await exists(join(path, '.git')))) return true
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: path })
  if (head.code === null) return false
  if (head.code !== 0) return true
  const lock = await git(['rev-parse', '--git-path', 'locked'], { cwd: path })
  if (lock.code !== 0) return false
  const reason = await readFile(resolve(path, lock.stdout.trim()), 'utf8').catch(() => null)
  return reason?.trim() === 'initializing'
}

// Called with the repo lock held. Two --force: the first ignores changes, the
// second the lock an unfinished `worktree add` left.
async function discardWorktree(bare: string, path: string): Promise<void> {
  await git(['worktree', 'remove', '--force', '--force', path], { cwd: bare })
  await rm(path, { recursive: true, force: true })
  await git(['worktree', 'prune'], { cwd: bare })
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

export async function headSha(worktree: string, timeoutMs?: number): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], { cwd: worktree, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  return result.code === 0 ? result.stdout.trim() : null
}

// Where HEAD forked from a branch; null when they share no history
export async function mergeBase(worktree: string, ref: string): Promise<string | null> {
  const result = await git(['merge-base', 'HEAD', ref], { cwd: worktree })
  return result.code === 0 ? result.stdout.trim() : null
}

// The runner is the only thing that pushes, and only to the branch the run
// holds a lease for (D8). Returns the pushed commit.
export async function pushBranch(worktree: string, branch: string, timeoutMs = PUSH_TIMEOUT_MS): Promise<{ sha: string, error: null } | { sha: null, error: string }> {
  const sha = await headSha(worktree)
  if (!sha) return { sha: null, error: 'The worktree has no commits' }
  const push = await git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree, timeoutMs })
  if (push.code !== 0) return { sha: null, error: push.stderr.trim() || 'git push failed' }
  return { sha, error: null }
}

interface SavedWork {
  // The WIP commit; null when there was nothing to save or it couldn't be made
  sha: string | null
  pushed: boolean
  error: string | null
}

// Commits whatever a stopped run left in its worktree and pushes the branch,
// all within timeoutMs. A clean worktree pushes nothing. The agent has exited
// by now, so a lock it left behind is stale. A commit that can't be pushed
// stays in the worktree, which the next run on this runner reuses.
export async function saveStoppedWork(worktree: string, branch: string, message: string, gitAuthor: GitAuthor | null, timeoutMs: number, canPush: () => boolean = () => true): Promise<SavedWork> {
  const failed = (error: string): SavedWork => ({ sha: null, pushed: false, error })
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(deadline - Date.now(), 1)
  const options = () => ({ cwd: worktree, timeoutMs: remaining() })

  if (!(await hasUncommittedChanges(worktree, remaining()))) return { sha: null, pushed: false, error: null }
  // In a rebase HEAD is a half-replayed commit, not the task branch
  const head = await git(['symbolic-ref', '--quiet', 'HEAD'], options())
  if (head.stdout.trim() !== `refs/heads/${branch}`) return failed(`the worktree is not on ${branch}`)

  const lock = await git(['rev-parse', '--git-path', 'index.lock'], options())
  if (lock.code === 0) await rm(resolve(worktree, lock.stdout.trim()), { force: true })
  const added = await git(['add', '--all'], options())
  if (added.code !== 0) return failed(added.stderr.trim() || 'git add failed')
  // A runner with no identity of its own still has to save the work
  const configured = gitAuthor ?? ((await git(['config', 'user.email'], options())).code === 0 ? null : FALLBACK_COMMITTER)
  const identity = configured
    ? { GIT_AUTHOR_NAME: configured.name, GIT_AUTHOR_EMAIL: configured.email, GIT_COMMITTER_NAME: configured.name, GIT_COMMITTER_EMAIL: configured.email }
    : {}
  // Hooks are for finished work, and this work may not even build
  const committed = await git(['commit', '--no-verify', '--quiet', '--message', message], { ...options(), env: identity })
  if (committed.code !== 0) return failed(committed.stderr.trim() || committed.stdout.trim() || 'git commit failed')

  if (!canPush()) return { sha: await headSha(worktree), pushed: false, error: 'no recent lease acknowledgement; keeping the commit local' }
  const pushed = await pushBranch(worktree, branch, remaining())
  if (pushed.sha === null) return { sha: await headSha(worktree), pushed: false, error: pushed.error }
  return { sha: pushed.sha, pushed: true, error: null }
}

async function hasUncommittedChanges(worktree: string, timeoutMs?: number): Promise<boolean> {
  const status = await git(['status', '--porcelain'], { cwd: worktree, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  return status.code !== 0 || status.stdout.trim().length > 0
}

// Removes a worktree unless it holds uncommitted work (PRD §7.4). Returns
// whether it was removed.
export function removeWorktree(repo: Repo, path: string, force = false): Promise<boolean> {
  return repo.withLock(async () => {
    if (!(await exists(path))) {
      await repo.git(['worktree', 'prune'])
      return true
    }
    if (!force && await hasUncommittedChanges(path)) return false
    const result = await repo.git(['worktree', 'remove', '--force', path])
    if (result.code !== 0) await rm(path, { recursive: true, force: true })
    await repo.git(['worktree', 'prune'])
    return true
  })
}

// Status only runs where the folder has its own working .git: git would
// otherwise answer for a repository above it, or fail on a dangling .git file
// that can't report changes at all
export async function removeOrphan(path: string): Promise<boolean> {
  const hasRepository = await exists(join(path, '.git')) && (await git(['rev-parse', '--git-dir'], { cwd: path })).code === 0
  if (hasRepository && await hasUncommittedChanges(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}
