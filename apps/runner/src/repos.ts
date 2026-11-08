import { SETUP_STEP_TIMEOUTS } from '@corral/contracts'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { git, type ExecOptions, type ExecResult } from './exec.ts'
import { barePath, exists } from './layout.ts'

// One bare clone per repository, fetched before each job (architecture.md,
// Layout on disk). Worktrees are created from it. Everything that works in a
// clone goes through its Repo, which carries the clone's lock.

export const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`

export interface Repo {
  readonly repository: string
  readonly bare: string
  // Git work that writes to the clone (fetches, adding and pruning worktrees)
  // runs one at a time per clone: concurrent runs would otherwise race on its ref locks
  withLock<T>(work: () => Promise<T>): Promise<T>
  // Clones on first use, then fetches. Returns an error message or null.
  sync(): Promise<string | null>
  // sync, throwing its error
  synced(): Promise<Repo>
  git(args: string[], options?: ExecOptions): Promise<ExecResult>
  // Its stdout, trimmed; throws on failure
  required(args: string[], options?: ExecOptions): Promise<string>
  revParse(ref: string): Promise<string | null>
  // A compare-and-swap: the remote refuses it unless the branch is still at
  // `expectedSha`, whatever this runner last fetched. Safe from a stale runner too.
  casPush(branch: string, expectedSha: string, sha: string): Promise<{ pushed: boolean, error: string | null }>
}

export function openRepo(dataDir: string, repository: string): Repo {
  const bare = barePath(dataDir, repository)
  const repo: Repo = {
    repository,
    bare,
    withLock: work => withRepoLock(bare, work),
    sync: () => syncRepository(bare, repository),
    async synced() {
      const error = await repo.sync()
      if (error) throw new Error(error)
      return repo
    },
    git: (args, options = {}) => git(args, { cwd: bare, ...options }),
    async required(args, options = {}) {
      const result = await repo.git(args, options)
      if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
      return result.stdout.trim()
    },
    async revParse(ref) {
      const result = await repo.git(['rev-parse', '--verify', '--quiet', ref])
      return result.code === 0 ? result.stdout.trim() : null
    },
    async casPush(branch, expectedSha, sha) {
      const ref = `refs/heads/${branch}`
      const push = await repo.git(['push', `--force-with-lease=${ref}:${expectedSha}`, 'origin', `${sha}:${ref}`], { timeoutMs: SETUP_STEP_TIMEOUTS.casPush })
      return { pushed: push.code === 0, error: push.code === 0 ? null : push.stderr.trim() || 'git push failed' }
    }
  }
  return repo
}

const repoQueues = new Map<string, Promise<unknown>>()

function withRepoLock<T>(bare: string, work: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(bare) ?? Promise.resolve()
  const result = previous.then(work, work)
  const settled = result.then(() => {}, () => {})
  repoQueues.set(bare, settled)
  void settled.then(() => {
    if (repoQueues.get(bare) === settled) repoQueues.delete(bare)
  })
  return result
}

const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*'

// The fetch for each clone that is queued and hasn't started. A caller arriving
// now joins it: it starts after they asked, so it can't miss what they need.
// One already running might, so it is never joined.
const queuedSyncs = new Map<string, Promise<string | null>>()

function syncRepository(path: string, repository: string): Promise<string | null> {
  const queued = queuedSyncs.get(path)
  if (queued) return queued
  const sync = withRepoLock(path, () => {
    queuedSyncs.delete(path)
    return cloneOrFetch(path, repository)
  })
  queuedSyncs.set(path, sync)
  return sync
}

async function cloneOrFetch(path: string, repository: string): Promise<string | null> {
  if (!(await cloned(path))) {
    const error = await clone(path, repository)
    if (error) return error
  }
  const fetch = await git(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: SETUP_STEP_TIMEOUTS.repoSync })
  return fetch.code === 0 ? null : fetch.stderr.trim() || 'git fetch failed'
}

// The refspec is set last, so a folder without one is a clone that was cut off.
// --git-dir stops git from answering for a repository above that folder.
async function cloned(path: string): Promise<boolean> {
  if (!(await exists(path))) return false
  const refspec = await git([`--git-dir=${path}`, 'config', '--get', 'remote.origin.fetch'])
  return refspec.code === null || refspec.code === 0
}

// Into a temporary folder and then renamed, so a clone that is cut off can
// never pass for a finished one. Holds the repo lock, so any temporary folder
// found here is left from a clone that died.
async function clone(path: string, repository: string): Promise<string | null> {
  const repos = dirname(path)
  await mkdir(repos, { recursive: true })
  const stale = (await readdir(repos)).filter(name => name.startsWith(`${basename(path)}.tmp-`))
  await Promise.all(stale.map(name => rm(join(repos, name), { recursive: true, force: true })))

  const temporary = `${path}.tmp-${randomUUID()}`
  const fail = async (error: string) => {
    await rm(temporary, { recursive: true, force: true })
    return error
  }
  const cloning = await git(['clone', '--bare', `https://github.com/${repository}.git`, temporary], { timeoutMs: SETUP_STEP_TIMEOUTS.repoSync })
  if (cloning.code !== 0) return fail(cloning.stderr.trim() || 'git clone failed')
  // Bare clones don't track the remote; make `origin/<branch>` refs available
  const config = await git(['config', 'remote.origin.fetch', FETCH_REFSPEC], { cwd: temporary })
  if (config.code !== 0) return fail(config.stderr.trim() || 'git config failed')
  await rm(path, { recursive: true, force: true })
  await rename(temporary, path)
  return null
}
