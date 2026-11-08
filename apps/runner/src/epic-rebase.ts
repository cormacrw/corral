import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupJob, SetupJobResult } from '@corral/contracts'
import { errorText } from '@corral/core'
import { FALLBACK_COMMITTER, type GitAuthor } from './config.ts'
import { git } from './exec.ts'
import { openRepo, remoteRef, type Repo } from './repos.ts'

type Job<K extends SetupJob['kind']> = Extract<SetupJob, { kind: K }>
type Result<K extends SetupJob['kind']> = Extract<SetupJobResult, { kind: K }>

const isAncestor = async (repo: Repo, ancestor: string, commit: string) => (await repo.git(['merge-base', '--is-ancestor', ancestor, commit])).code === 0
const lines = (text: string) => text.split('\n').filter(Boolean)
// Both sides of a rename count: only its new path would show otherwise
const changed = async (repo: Repo, from: string, to: string) => lines(await repo.required(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', from, to]))

// In the throwaway worktree rather than the clone
async function required(args: string[], cwd: string): Promise<string> {
  const result = await git(args, { cwd })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout.trim()
}

// Rebases in a throwaway detached worktree: no shared ref moves, and a conflict
// is aborted and thrown away, so the epic branch stays as it was (D27).
async function rebase(repo: Repo, author: GitAuthor | null, job: Job<'epic_rebase_prepare'>): Promise<Result<'epic_rebase_prepare'>> {
  const outcome = (status: Result<'epic_rebase_prepare'>['status'], commitSha: string | null = null, files: string[] = []) => ({ kind: 'epic_rebase_prepare' as const, status, commitSha, files })
  if (await isAncestor(repo, job.ontoSha, job.expectedHeadSha)) return outcome('up_to_date', job.expectedHeadSha)
  const parent = await mkdtemp(join(tmpdir(), 'corral-epic-rebase-'))
  const path = join(parent, 'candidate')
  try {
    await repo.required(['worktree', 'add', '--quiet', '--detach', path, job.expectedHeadSha])
    const committer = author ?? FALLBACK_COMMITTER
    const rebased = await git(['-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, '-c', 'commit.gpgsign=false', 'rebase', '--quiet', job.ontoSha], { cwd: path })
    if (rebased.code === 0) return outcome('rebased', await required(['rev-parse', 'HEAD'], path))
    const files = lines(await required(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], path))
    if (files.length === 0) throw new Error(rebased.stderr.trim() || 'git rebase failed')
    return outcome('conflict', null, files)
  } finally {
    await repo.git(['worktree', 'remove', '--force', path])
    await repo.git(['worktree', 'prune'])
    await rm(parent, { recursive: true, force: true })
  }
}

// A throw means the runner couldn't reach the remote; `failed` that git couldn't
// do the rebase. The server bounds both.
export async function prepareEpicRebase(dataDir: string, author: GitAuthor | null, job: Job<'epic_rebase_prepare'>): Promise<Result<'epic_rebase_prepare'>> {
  const repo = await openRepo(dataDir, job.repository).synced()
  return repo.withLock(async () => {
    const head = await repo.required(['rev-parse', remoteRef(job.epicBranch)])
    if (head !== job.expectedHeadSha) return { kind: 'epic_rebase_prepare', status: 'moved', commitSha: null, files: [] }
    return rebase(repo, author, job).catch((failure: unknown) => ({
      kind: 'epic_rebase_prepare' as const, status: 'failed' as const, commitSha: null, files: [], error: errorText(failure)
    }))
  })
}

// What the target renamed, as [from, to]: rebasing follows these, so an edit of
// `from` lands in `to`
async function renames(repo: Repo, from: string, to: string): Promise<[string, string][]> {
  const entries = lines(await repo.required(['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', from, to])).map(line => line.split('\t'))
  return entries.filter(([status]) => status!.startsWith('R')).map(([, source, destination]) => [source!, destination!])
}

const exists = async (repo: Repo, commit: string, file: string) => (await repo.git(['cat-file', '-e', `${commit}:${file}`])).code === 0

// What a candidate does to the target's work. `undone` holds the files only the
// target changed that the candidate leaves different from the target. A file the
// target renamed under the epic's edit carries that edit, so it's both sides'
// and only has to survive at its new path. The epic's own files don't count.
// The push guard and the rebase review share this, so a reviewer is shown
// exactly what the guard would otherwise refuse. A CI or review fix sits on the
// head it fixes, so nothing separates the sides by history: there, a file that
// was already there and that the epic never changed is the target's. A new file
// is the fix's own.
async function targetChanges(repo: Repo, job: { targetBranch: string, expectedHeadSha: string, candidateSha: string }) {
  const base = await repo.required(['merge-base', job.candidateSha, remoteRef(job.targetBranch)])
  const fork = await repo.required(['merge-base', job.expectedHeadSha, base])
  const epicFiles = new Set(await changed(repo, fork, job.expectedHeadSha))
  const carried = (await renames(repo, fork, base)).filter(([from]) => epicFiles.has(from))
  const shared = new Set([...epicFiles, ...carried.map(([, to]) => to)])
  if (fork === base) {
    const edited = (await changed(repo, job.expectedHeadSha, job.candidateSha)).filter(file => !shared.has(file))
    const present = await Promise.all(edited.map(file => exists(repo, base, file)))
    return { base, carried, undone: edited.filter((_, i) => present[i]) }
  }
  const targetOnly = (await changed(repo, fork, base)).filter(file => !shared.has(file))
  const altered = new Set(await changed(repo, base, job.candidateSha))
  return { base, carried, undone: targetOnly.filter(file => altered.has(file)) }
}

// What's wrong with a candidate, if anything. The candidate must sit on the
// commit it was asked to reach or a later one, stay linear, keep the target's
// renames unless the epic moved or deleted the file too, and leave files only
// the target changed exactly as the target has them. Git alone has no reason to
// touch those, so a difference is target work undone. The one exception is a
// resolution whose reviewer approved this commit having been shown each such
// change: the epic can force an adaptation there, which is the reviewer's to judge.
async function candidateProblem(repo: Repo, job: Job<'epic_rebase_push'>): Promise<string | null> {
  if (!await isAncestor(repo, job.ontoSha, job.candidateSha)) return `It isn't rebased onto ${job.ontoSha}.`
  const { base, carried, undone } = await targetChanges(repo, job)
  const merges = lines(await repo.required(['rev-list', '--merges', `${base}..${job.candidateSha}`]))
  if (merges.length > 0) return `It has merge commits (${merges.join(', ')}). Rebase, never merge.`
  for (const [from, to] of carried) {
    if (await exists(repo, job.expectedHeadSha, from) && !await exists(repo, job.candidateSha, to)) return `It undoes the target's rename of ${from} to ${to}. Keep the file at ${to}, with the epic's change in it.`
  }
  return undone.length > 0 && !job.reviewed ? `It changes target branch work the task never touched: ${undone.join(', ')}. Keep the target's version of these files.` : null
}

// A prompt can hold only so much. The reviewer has the checkout for the rest.
const MAX_DIFF_CHARS = 20_000

// The changes to files only the target changed, for the rebase reviewer. A throw
// means the runner couldn't read them, which the server treats as a wait.
export async function inspectEpicRebase(dataDir: string, job: Job<'epic_rebase_inspect'>): Promise<Result<'epic_rebase_inspect'>> {
  const repo = await openRepo(dataDir, job.repository).synced()
  return repo.withLock(async () => {
    const { base, undone } = await targetChanges(repo, job)
    const targetFiles = await Promise.all(undone.map(async (path) => {
      const diff = await repo.required(['diff', base, job.candidateSha, '--', path])
      return { path, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS }
    }))
    return { kind: 'epic_rebase_inspect', targetFiles }
  })
}

// A compare-and-swap, as for task integration: the push fails unless the epic
// branch is still at the expected head. Failures are for the server to settle
// from a fresh read of the branch.
export async function pushEpicRebase(dataDir: string, job: Job<'epic_rebase_push'>): Promise<Result<'epic_rebase_push'>> {
  const repo = openRepo(dataDir, job.repository)
  const error = await repo.sync()
  if (error) return { kind: 'epic_rebase_push', pushed: false, rejected: null, error }
  return repo.withLock(async () => {
    const rejected = await candidateProblem(repo, job)
    if (rejected) return { kind: 'epic_rebase_push', pushed: false, rejected, error: null }
    return { kind: 'epic_rebase_push', rejected: null, ...await repo.casPush(job.epicBranch, job.expectedHeadSha, job.candidateSha) }
  })
}
