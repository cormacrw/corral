import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './exec.ts'

// One bare clone per repository under <dataDir>/repos, fetched before each
// job (architecture.md, Layout on disk). Worktrees are created from it.
export function barePath(dataDir: string, repository: string): string {
  return join(dataDir, 'repos', `${repository.replace('/', '__')}.git`)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

// Clones on first use, then fetches. Returns an error message or null.
export async function syncRepository(dataDir: string, repository: string): Promise<string | null> {
  const path = barePath(dataDir, repository)
  if (!(await exists(path))) {
    await mkdir(join(dataDir, 'repos'), { recursive: true })
    const clone = await git(['clone', '--bare', `https://github.com/${repository}.git`, path], { timeoutMs: 10 * 60_000 })
    if (clone.code !== 0) return clone.stderr.trim() || 'git clone failed'
    // Bare clones don't track the remote; make `origin/<branch>` refs available
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: path })
  }
  const fetch = await git(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: 10 * 60_000 })
  return fetch.code === 0 ? null : fetch.stderr.trim() || 'git fetch failed'
}
