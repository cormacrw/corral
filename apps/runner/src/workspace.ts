import type { RunJob } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { GitAuthor } from './config.ts'
import { exec, git } from './exec.ts'
import { barePath, exists, syncRepository, withRepoLock } from './repos.ts'
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

export interface Workspace {
  path: string
  bare: string
}

// Fetches the bare clone and creates or reuses the worktree for this run.
// Returns an error message instead of throwing, so the run can fail cleanly.
export async function prepareWorkspace(dataDir: string, job: RunJob): Promise<Prepared> {
  const syncError = await syncRepository(dataDir, job.repository)
  if (syncError) return { workspace: null, error: `Could not fetch ${job.repository}: ${syncError}` }
  const bare = barePath(dataDir, job.repository)
  // Adding worktrees writes to the bare clone too, so it takes the same lock
  return withRepoLock(bare, () => checkOut(dataDir, bare, job))
}

type Prepared = { workspace: Workspace, error: null } | { workspace: null, error: string }

// A checkout of a large repository under load can take minutes
const CHECKOUT_TIMEOUT_MS = 10 * 60_000

async function checkOut(dataDir: string, bare: string, job: RunJob): Promise<Prepared> {
  // Forget worktrees whose folders were removed by hand
  await git(['worktree', 'prune'], { cwd: bare })
  const prepared = (path: string, error: string | null): Prepared => error ? { workspace: null, error } : { workspace: { path, bare }, error: null }

  if (job.role === 'pm') {
    // A read-only checkout of the default branch (D9), one per Plan session
    if (!job.planSessionId) return { workspace: null, error: 'The job has no plan session' }
    const path = pmWorktreePath(dataDir, job.projectId, job.planSessionId)
    return prepared(path, await checkoutOrAdd(bare, path, `origin/${job.defaultBranch}`))
  }

  const workId = job.taskId ?? (job.role === 'reviewer' && job.epicId ? `epic-${job.epicId}` : null)
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

  // Developer: reuse the worktree between revisions (D10) so uncommitted
  // work is never lost; otherwise start the branch from origin
  if (await keptWorktree(bare, path)) return prepared(path, job.continueFrom ? await catchUp(path, job.continueFrom) : null)
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${job.branch}`], { cwd: bare })
  const start = remote.code === 0 ? `origin/${job.branch}` : `origin/${job.baseBranch ?? job.defaultBranch}`
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
export async function pushBranch(worktree: string, branch: string, timeoutMs = 5 * 60_000): Promise<{ sha: string, error: null } | { sha: null, error: string }> {
  const sha = await headSha(worktree)
  if (!sha) return { sha: null, error: 'The worktree has no commits' }
  const push = await git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree, timeoutMs })
  if (push.code !== 0) return { sha: null, error: push.stderr.trim() || 'git push failed' }
  return { sha, error: null }
}

export const WIP_AUTHOR: GitAuthor = { name: 'Corral', email: 'corral@localhost' }

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
  const configured = gitAuthor ?? ((await git(['config', 'user.email'], options())).code === 0 ? null : WIP_AUTHOR)
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

export async function hasUncommittedChanges(worktree: string, timeoutMs?: number): Promise<boolean> {
  const status = await git(['status', '--porcelain'], { cwd: worktree, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
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

// Ids are database UUIDs, so anything else under worktrees/ isn't ours
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TASK_FOLDER = new RegExp(`^(${UUID})(-review)?$`)
const PM_FOLDER = new RegExp(`^pm-${UUID}-(${UUID})$`)
const EPIC_FOLDER = new RegExp(`^epic-(${UUID})-review$`)
const RUN_FOLDER = new RegExp(`^${UUID}$`)
const RUN_SPOOL = new RegExp(`^(${UUID})\\.jsonl$`)

interface KeepLists {
  keepTaskIds: string[]
  keepPlanSessionIds: string[]
  // An older server doesn't send this, and then epic checkouts are left alone
  keepEpicIds?: string[] | undefined
}

// Removes every worktree outside the keep lists. A developer worktree or an
// orphan with uncommitted changes stays (PRD §7.4); review and PM checkouts
// are read-only by contract, so theirs are discarded. Scratch and spool files
// nothing needs go too, without a place in the result: it's about worktrees.
export async function sweepWorktrees(
  dataDir: string,
  keep: KeepLists,
  pmTurnRunning: (planSessionId: string) => boolean,
  runIsHere: (runId: string) => boolean = () => true
): Promise<{ removed: string[], kept: string[] }> {
  const root = join(dataDir, 'worktrees')
  const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
  const registered = await registeredWorktrees(dataDir)
  const removed: string[] = []
  const kept: string[] = []
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const task = TASK_FOLDER.exec(folder.name)
    const planSessionId = PM_FOLDER.exec(folder.name)?.[1]
    const epicId = keep.keepEpicIds ? EPIC_FOLDER.exec(folder.name)?.[1] : undefined
    if (!task && !planSessionId && !epicId) continue
    if (task ? keep.keepTaskIds.includes(task[1]!) : planSessionId ? keep.keepPlanSessionIds.includes(planSessionId) : keep.keepEpicIds!.includes(epicId!)) continue

    const path = join(root, folder.name)
    const bare = registered.get(await realpath(path))
    // Nothing awaits between this check and removeWorktree taking its place
    // in the repo queue, so a turn starting later checks out after the removal
    if (planSessionId && pmTurnRunning(planSessionId)) continue
    const force = planSessionId !== undefined || epicId !== undefined || task?.[2] !== undefined
    const gone = bare ? await removeWorktree(bare, path, force) : await removeOrphan(path)
    ;(gone ? removed : kept).push(path)
  }
  await sweepRunFiles(dataDir, keep, pmTurnRunning, runIsHere).catch((error: unknown) => {
    console.warn(`Could not sweep the scratch folders: ${error instanceof Error ? error.message : String(error)}`)
  })
  return { removed, kept }
}

// Design copies are read-only, and rm can't empty a read-only folder
export async function removeScratch(path: string): Promise<void> {
  await exec('chmod', ['-R', 'u+w', path])
  await rm(path, { recursive: true, force: true })
}

// A Plan session's scratch folder goes with its session. A run's goes when the
// run ends; these are what a runner that died left behind. Nothing awaits
// between each check and its removal starting, and a new run isn't on disk yet.
async function sweepRunFiles(dataDir: string, keep: KeepLists, pmTurnRunning: (planSessionId: string) => boolean, runIsHere: (runId: string) => boolean): Promise<void> {
  const scratch = join(dataDir, 'scratch')
  for (const folder of await readdir(scratch).catch(() => [])) {
    const planSessionId = PM_FOLDER.exec(folder)?.[1]
    const unused = planSessionId
      ? !keep.keepPlanSessionIds.includes(planSessionId) && !pmTurnRunning(planSessionId)
      : RUN_FOLDER.test(folder) && !runIsHere(folder)
    if (unused) await removeScratch(join(scratch, folder))
  }
  const spool = join(dataDir, 'spool')
  for (const file of await readdir(spool).catch(() => [])) {
    const runId = RUN_SPOOL.exec(file)?.[1]
    if (runId && !runIsHere(runId)) await rm(join(spool, file), { force: true })
  }
}

// Each worktree's real path and its bare clone, as barePath spells it so
// removeWorktree takes the same lock as the runs. Throws when a clone can't
// answer: its worktrees would otherwise look like orphans.
async function registeredWorktrees(dataDir: string): Promise<Map<string, string>> {
  const repos = join(dataDir, 'repos')
  const clones = await readdir(repos).catch(() => [])
  const registered = new Map<string, string>()
  for (const clone of clones.filter(name => name.endsWith('.git'))) {
    const bare = join(repos, clone)
    const list = await git(['worktree', 'list', '--porcelain'], { cwd: bare })
    if (list.code !== 0) throw new Error(`git worktree list failed in ${clone}: ${list.stderr.trim()}`)
    for (const [, path] of list.stdout.matchAll(/^worktree (.+)$/gm)) {
      registered.set(await realpath(path!).catch(() => path!), bare)
    }
  }
  return registered
}

// Status only runs where the folder has its own working .git: git would
// otherwise answer for a repository above it, or fail on a dangling .git file
// that can't report changes at all
async function removeOrphan(path: string): Promise<boolean> {
  const hasRepository = await exists(join(path, '.git')) && (await git(['rev-parse', '--git-dir'], { cwd: path })).code === 0
  if (hasRepository && await hasUncommittedChanges(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}
