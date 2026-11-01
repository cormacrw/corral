import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupJob, SetupJobResult } from '@corral/contracts'
import type { GitAuthor } from './config.ts'
import { git } from './exec.ts'
import { barePath, syncRepository, withRepoLock } from './repos.ts'
import { WIP_AUTHOR } from './workspace.ts'

type Job<K extends SetupJob['kind']> = Extract<SetupJob, { kind: K }>
type Result<K extends SetupJob['kind']> = Extract<SetupJobResult, { kind: K }>

const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`

async function required(args: string[], cwd: string): Promise<string> {
  const result = await git(args, { cwd })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout.trim()
}

const isAncestor = async (bare: string, ancestor: string, commit: string) => (await git(['merge-base', '--is-ancestor', ancestor, commit], { cwd: bare })).code === 0
const lines = (text: string) => text.split('\n').filter(Boolean)
const changed = async (bare: string, from: string, to: string) => lines(await required(['-c', 'core.quotePath=false', 'diff', '--name-only', from, to], bare))

// Rebases in a throwaway detached worktree: no shared ref moves, and a conflict
// is aborted and thrown away, so the epic branch stays as it was (D27).
async function rebase(bare: string, author: GitAuthor | null, job: Job<'epic_rebase_prepare'>): Promise<Result<'epic_rebase_prepare'>> {
  const outcome = (status: Result<'epic_rebase_prepare'>['status'], commitSha: string | null = null, files: string[] = []) => ({ kind: 'epic_rebase_prepare' as const, status, commitSha, files })
  if (await isAncestor(bare, job.ontoSha, job.expectedHeadSha)) return outcome('up_to_date', job.expectedHeadSha)
  const parent = await mkdtemp(join(tmpdir(), 'corral-epic-rebase-'))
  const path = join(parent, 'candidate')
  try {
    await required(['worktree', 'add', '--quiet', '--detach', path, job.expectedHeadSha], bare)
    const committer = author ?? WIP_AUTHOR
    const rebased = await git(['-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, '-c', 'commit.gpgsign=false', 'rebase', '--quiet', job.ontoSha], { cwd: path })
    if (rebased.code === 0) return outcome('rebased', await required(['rev-parse', 'HEAD'], path))
    const files = lines(await required(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], path))
    if (files.length === 0) throw new Error(rebased.stderr.trim() || 'git rebase failed')
    return outcome('conflict', null, files)
  } finally {
    await git(['worktree', 'remove', '--force', path], { cwd: bare })
    await git(['worktree', 'prune'], { cwd: bare })
    await rm(parent, { recursive: true, force: true })
  }
}

// A throw means the runner couldn't reach the remote; `failed` that git couldn't
// do the rebase. The server bounds both.
export async function prepareEpicRebase(dataDir: string, author: GitAuthor | null, job: Job<'epic_rebase_prepare'>): Promise<Result<'epic_rebase_prepare'>> {
  const error = await syncRepository(dataDir, job.repository)
  if (error) throw new Error(error)
  const bare = barePath(dataDir, job.repository)
  return withRepoLock(bare, async () => {
    const head = await required(['rev-parse', remoteRef(job.epicBranch)], bare)
    if (head !== job.expectedHeadSha) return { kind: 'epic_rebase_prepare', status: 'moved', commitSha: null, files: [] }
    return rebase(bare, author, job).catch((failure: unknown) => ({
      kind: 'epic_rebase_prepare' as const, status: 'failed' as const, commitSha: null, files: [], error: failure instanceof Error ? failure.message : String(failure)
    }))
  })
}

// What's wrong with a candidate, if anything. The candidate must sit on the
// commit it was asked to reach or a later one, stay linear, and leave files only
// the target changed exactly as the target has them: an agent resolving a
// conflict has no reason to touch those, so a difference is target work undone.
// The epic's own files are the reviewer's to judge.
async function candidateProblem(bare: string, job: Job<'epic_rebase_push'>): Promise<string | null> {
  const target = remoteRef(job.targetBranch)
  if (!await isAncestor(bare, job.ontoSha, job.candidateSha)) return `It isn't rebased onto ${job.ontoSha}.`
  const base = await required(['merge-base', job.candidateSha, target], bare)
  const merges = lines(await required(['rev-list', '--merges', `${base}..${job.candidateSha}`], bare))
  if (merges.length > 0) return `It has merge commits (${merges.join(', ')}). Rebase, never merge.`
  const fork = await required(['merge-base', job.expectedHeadSha, base], bare)
  const epicFiles = new Set(await changed(bare, fork, job.expectedHeadSha))
  const targetOnly = (await changed(bare, fork, base)).filter(file => !epicFiles.has(file))
  const altered = new Set(await changed(bare, base, job.candidateSha))
  const undone = targetOnly.filter(file => altered.has(file))
  return undone.length > 0 ? `It changes target branch work the epic never touched: ${undone.join(', ')}. Keep the target's version of these files.` : null
}

// A compare-and-swap, as for task integration: the push fails unless the epic
// branch is still at the expected head. Failures are for the server to settle
// from a fresh read of the branch.
export async function pushEpicRebase(dataDir: string, job: Job<'epic_rebase_push'>): Promise<Result<'epic_rebase_push'>> {
  const error = await syncRepository(dataDir, job.repository)
  if (error) return { kind: 'epic_rebase_push', pushed: false, rejected: null, error }
  const bare = barePath(dataDir, job.repository)
  return withRepoLock(bare, async () => {
    const rejected = await candidateProblem(bare, job)
    if (rejected) return { kind: 'epic_rebase_push', pushed: false, rejected, error: null }
    const ref = `refs/heads/${job.epicBranch}`
    const push = await git(['push', `--force-with-lease=${ref}:${job.expectedHeadSha}`, 'origin', `${job.candidateSha}:${ref}`], { cwd: bare, timeoutMs: 2 * 60_000 })
    return { kind: 'epic_rebase_push', pushed: push.code === 0, rejected: null, error: push.code === 0 ? null : push.stderr.trim() || 'git push failed' }
  })
}
