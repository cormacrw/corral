import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { git } from './exec.ts'

// One bare clone per repository under <dataDir>/repos, fetched before each
// job (architecture.md, Layout on disk). Worktrees are created from it.
export function barePath(dataDir: string, repository: string): string {
  return join(dataDir, 'repos', `${repository.replace('/', '__')}.git`)
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

// Git work that writes to a bare clone (fetches, adding and pruning
// worktrees) runs one at a time per clone: concurrent runs would otherwise
// race on its ref locks
const repoQueues = new Map<string, Promise<unknown>>()

export function withRepoLock<T>(bare: string, work: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(bare) ?? Promise.resolve()
  const result = previous.then(work, work)
  const settled = result.then(() => {}, () => {})
  repoQueues.set(bare, settled)
  void settled.then(() => {
    if (repoQueues.get(bare) === settled) repoQueues.delete(bare)
  })
  return result
}

const CLONE_TIMEOUT_MS = 10 * 60_000
const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*'

// The fetch for each clone that is queued and hasn't started. A caller arriving
// now joins it: it starts after they asked, so it can't miss what they need.
// One already running might, so it is never joined.
const queuedSyncs = new Map<string, Promise<string | null>>()

// Clones on first use, then fetches. Returns an error message or null.
export function syncRepository(dataDir: string, repository: string): Promise<string | null> {
  const path = barePath(dataDir, repository)
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
  const fetch = await git(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: CLONE_TIMEOUT_MS })
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
  const cloning = await git(['clone', '--bare', `https://github.com/${repository}.git`, temporary], { timeoutMs: CLONE_TIMEOUT_MS })
  if (cloning.code !== 0) return fail(cloning.stderr.trim() || 'git clone failed')
  // Bare clones don't track the remote; make `origin/<branch>` refs available
  const config = await git(['config', 'remote.origin.fetch', FETCH_REFSPEC], { cwd: temporary })
  if (config.code !== 0) return fail(config.stderr.trim() || 'git config failed')
  await rm(path, { recursive: true, force: true })
  await rename(temporary, path)
  return null
}
