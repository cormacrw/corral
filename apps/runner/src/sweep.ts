import type { SetupJob } from '@corral/contracts'
import { errorText } from '@corral/core'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cloneRepository, discardsChanges, globalSessionPath, reposDir, scratchDir, scratchFolder, sessionFolder, sessionsDir, spoolDir, spoolFile, turboCacheDir, worktreeFolder, worktreesDir } from './layout.ts'
import { openRepo, type Repo } from './repos.ts'
import { removeScratch } from './designs.ts'
import { removeOrphan, removeWorktree } from './workspace.ts'

// What the sweep may ask about this runner's own runs, so it leaves their files alone
export interface LocalRuns {
  // A Plan session has a turn in progress here
  pmTurnRunning(planSessionId: string): boolean
  // A run is still this runner's
  hasRun(runId: string): boolean
  // A project has a run here, so its Turbo cache isn't pruned
  projectRunning(projectId: string): boolean
}

type KeepLists = Omit<Extract<SetupJob, { kind: 'sweep_worktrees' }>, 'kind'>

// Removes every worktree outside the keep lists. Uncommitted changes stay
// where discardsChanges says so, and in an orphan; a global session's folder
// goes. Scratch and spool files nothing needs go too, without a
// place in the result: it's about worktrees.
export async function sweepWorktrees(dataDir: string, keep: KeepLists, runs: LocalRuns): Promise<{ removed: string[], kept: string[] }> {
  const root = worktreesDir(dataDir)
  const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
  const registered = await registeredWorktrees(dataDir)
  const removed: string[] = []
  const kept: string[] = []
  for (const entry of folders) {
    if (!entry.isDirectory()) continue
    const folder = worktreeFolder(entry.name)
    // An older server doesn't send keepEpicIds, and then epic checkouts are left alone
    if (!folder || (folder.kind === 'epic' && !keep.keepEpicIds)) continue
    const keptHere = folder.kind === 'task'
      ? keep.keepTaskIds.includes(folder.taskId)
      : folder.kind === 'pm' ? keep.keepPlanSessionIds.includes(folder.planSessionId) : keep.keepEpicIds!.includes(folder.epicId)
    if (keptHere) continue

    const path = join(root, entry.name)
    const repo = registered.get(await realpath(path))
    // Nothing awaits between this check and removeWorktree taking its place
    // in the repo queue, so a turn starting later checks out after the removal
    if (folder.kind === 'pm' && runs.pmTurnRunning(folder.planSessionId)) continue
    const gone = repo ? await removeWorktree(repo, path, discardsChanges(folder)) : await removeOrphan(path)
    ;(gone ? removed : kept).push(path)
  }
  for (const name of await readdir(sessionsDir(dataDir)).catch(() => [])) {
    const planSessionId = sessionFolder(name)
    if (!planSessionId || keep.keepPlanSessionIds.includes(planSessionId) || runs.pmTurnRunning(planSessionId)) continue
    const path = globalSessionPath(dataDir, planSessionId)
    await removeScratch(path)
    removed.push(path)
  }
  await sweepRunFiles(dataDir, keep, runs).catch((error: unknown) => {
    console.warn(`Could not sweep the scratch folders: ${errorText(error)}`)
  })
  await pruneTurboCaches(dataDir, project => runs.projectRunning(project)).catch((error: unknown) => {
    console.warn(`Could not prune the Turbo caches: ${errorText(error)}`)
  })
  return { removed, kept }
}

// A Plan session's scratch folder goes with its session. A run's goes when the
// run ends; these are what a runner that died left behind. Nothing awaits
// between each check and its removal starting, and a new run isn't on disk yet.
async function sweepRunFiles(dataDir: string, keep: KeepLists, runs: LocalRuns): Promise<void> {
  const scratch = scratchDir(dataDir)
  for (const name of await readdir(scratch).catch(() => [])) {
    const folder = scratchFolder(name)
    const unused = folder?.kind === 'session'
      ? !keep.keepPlanSessionIds.includes(folder.planSessionId) && !runs.pmTurnRunning(folder.planSessionId)
      : folder?.kind === 'run' && !runs.hasRun(folder.runId)
    if (unused) await removeScratch(join(scratch, name))
  }
  const spool = spoolDir(dataDir)
  for (const name of await readdir(spool).catch(() => [])) {
    const runId = spoolFile(name)
    if (runId && !runs.hasRun(runId)) await rm(join(spool, name), { force: true })
  }
}

const TURBO_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const TURBO_CACHE_MAX_BYTES = 5 * 1024 ** 3

// Turbo never evicts local entries. An entry is a task hash's files
// (<hash>.tar.zst, <hash>-meta.json, <hash>-manifest.json); its last use is the newest atime or
// mtime of them. Entries unused for the age limit go, then the oldest until
// the project is under the size cap. A project with a run on this runner is
// left alone: its agent may be reading or writing entries right now.
export async function pruneTurboCaches(
  dataDir: string,
  projectRunning: (projectId: string) => boolean,
  now = Date.now(),
  limits: { maxAgeMs: number, maxBytes: number } = { maxAgeMs: TURBO_CACHE_MAX_AGE_MS, maxBytes: TURBO_CACHE_MAX_BYTES }
): Promise<void> {
  const root = turboCacheDir(dataDir)
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory() || projectRunning(project.name)) continue
    const folder = join(root, project.name)
    const entries = new Map<string, { files: string[], used: number, bytes: number }>()
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (!file.isFile()) continue
      const info = await stat(join(folder, file.name)).catch(() => null)
      if (!info) continue
      const hash = /^[^-.]+/.exec(file.name)?.[0] ?? file.name
      const entry = entries.get(hash) ?? { files: [], used: 0, bytes: 0 }
      entry.files.push(file.name)
      entry.used = Math.max(entry.used, info.atimeMs, info.mtimeMs)
      entry.bytes += info.size
      entries.set(hash, entry)
    }
    const oldestFirst = [...entries.values()].sort((a, b) => a.used - b.used)
    let total = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of oldestFirst) {
      if (now - entry.used <= limits.maxAgeMs && total <= limits.maxBytes) break
      for (const file of entry.files) await rm(join(folder, file), { force: true })
      total -= entry.bytes
    }
  }
}

// Each worktree's real path and its clone, opened by repository so
// removeWorktree takes the same lock as the runs. Throws when a clone can't
// answer: its worktrees would otherwise look like orphans.
async function registeredWorktrees(dataDir: string): Promise<Map<string, Repo>> {
  const registered = new Map<string, Repo>()
  for (const name of await readdir(reposDir(dataDir)).catch(() => [])) {
    const repository = cloneRepository(name)
    if (!repository) continue
    const repo = openRepo(dataDir, repository)
    const list = await repo.git(['worktree', 'list', '--porcelain'])
    if (list.code !== 0) throw new Error(`git worktree list failed in ${name}: ${list.stderr.trim()}`)
    for (const [, path] of list.stdout.matchAll(/^worktree (.+)$/gm)) {
      registered.set(await realpath(path!).catch(() => path!), repo)
    }
  }
  return registered
}
