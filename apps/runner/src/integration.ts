import type { SetupJob, SetupJobResult } from '@corral/contracts'
import type { GitAuthor } from './config.ts'
import { git } from './exec.ts'
import { barePath, syncRepository, withRepoLock } from './repos.ts'
import { WIP_AUTHOR } from './workspace.ts'

type Job<K extends SetupJob['kind']> = Extract<SetupJob, { kind: K }>
type Result<K extends SetupJob['kind']> = Extract<SetupJobResult, { kind: K }>

// PR-free integration runs in the bare clone: nothing here needs a worktree, so
// the task's own worktree and branch stay exactly as they were reviewed (D27).

const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`

async function required(args: string[], bare: string, input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(args, { cwd: bare, ...(input !== undefined && { input }), ...(env && { env }) })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout.trim()
}

async function sync(dataDir: string, repository: string): Promise<string> {
  const error = await syncRepository(dataDir, repository)
  if (error) throw new Error(error)
  return barePath(dataDir, repository)
}

async function revParse(bare: string, ref: string): Promise<string | null> {
  const result = await git(['rev-parse', '--verify', '--quiet', ref], { cwd: bare })
  return result.code === 0 ? result.stdout.trim() : null
}

// The trailer survives the epic branch being rebased, so a submission is found
// on the remote whatever its commit's SHA has become
export const submissionTrailer = (submissionId: string) => `Corral-Submission: ${submissionId}`

async function findIntegrated(bare: string, targetBranch: string, submissionId: string): Promise<string | null> {
  const found = await required(['log', '-1', '--format=%H', '--fixed-strings', `--grep=${submissionTrailer(submissionId)}`, remoteRef(targetBranch)], bare)
  return found || null
}

// One commit on top of the expected epic head holding the submission's own
// change, three-way merged when the epic moved. A squash of the task, parented
// on its base, is what's merged: `merge-tree --merge-base` needs git 2.40, and
// the task's commits stay out of the shared history either way.
async function buildCandidate(bare: string, author: GitAuthor | null, job: Job<'integration_prepare'>): Promise<Result<'integration_prepare'>> {
  const prepared = (status: Result<'integration_prepare'>['status'], commitSha: string | null = null, files: string[] = []) =>
    ({ kind: 'integration_prepare' as const, status, targetSha: job.expectedTargetSha, commitSha, files })
  const [name, email] = (await required(['log', '-1', '--format=%an%x00%ae', job.headSha], bare)).split('\0') as [string, string]
  const committer = author ?? WIP_AUTHOR
  const env = {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: job.committedAt,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: job.committedAt
  }
  const squash = await required(['commit-tree', `${job.headSha}^{tree}`, '-p', job.baseSha, '-F', '-'], bare, job.message, env)
  const merged = await git(['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '--no-messages', job.expectedTargetSha, squash], { cwd: bare })
  if (merged.code !== 0 && merged.code !== 1) throw new Error(merged.stderr.trim() || 'git merge-tree failed')
  const [tree, ...conflicted] = merged.stdout.split('\n').filter(Boolean)
  if (merged.code === 1) return prepared('conflict', null, conflicted)
  if (tree === await required(['rev-parse', `${job.expectedTargetSha}^{tree}`], bare)) return prepared('empty')
  const candidate = await required(['commit-tree', tree!, '-p', job.expectedTargetSha, '-F', '-'], bare, job.message, env)
  return prepared('prepared', candidate)
}

// Changes no shared ref. An already integrated submission is reported rather
// than rebuilt, so a retry after a lost answer can't add a second commit. A
// candidate that can't be built is the submission's problem and comes back as
// `failed`; a throw means the runner couldn't reach the remote, which says
// nothing about the submission.
export async function prepareIntegration(dataDir: string, author: GitAuthor | null, job: Job<'integration_prepare'>): Promise<Result<'integration_prepare'>> {
  const bare = await sync(dataDir, job.repository)
  return withRepoLock(bare, async () => {
    const target = await revParse(bare, remoteRef(job.targetBranch))
    if (!target) throw new Error(`Branch ${job.targetBranch} doesn't exist`)
    const integrated = await findIntegrated(bare, job.targetBranch, job.submissionId)
    if (integrated) return { kind: 'integration_prepare', status: 'integrated', targetSha: target, commitSha: integrated, files: [] }
    if (target !== job.expectedTargetSha) return { kind: 'integration_prepare', status: 'moved', targetSha: target, commitSha: null, files: [] }
    const built = await buildCandidate(bare, author, job).catch((error: unknown) => ({
      kind: 'integration_prepare' as const, status: 'failed' as const, targetSha: target, commitSha: null, files: [], error: error instanceof Error ? error.message : String(error)
    }))
    if (built.status === 'prepared' && job.candidateRef) await required(['push', '--force', 'origin', `${built.commitSha}:refs/heads/${job.candidateRef}`], bare)
    return built
  })
}

// The compare-and-swap: GitHub refuses this unless the branch is still at the
// expected head, whatever this runner last fetched. That makes it safe from a
// stale runner too. Any failure, a timeout included, is for inspect to settle.
export async function pushIntegration(dataDir: string, job: Job<'integration_push'>): Promise<Result<'integration_push'>> {
  const bare = barePath(dataDir, job.repository)
  return withRepoLock(bare, async () => {
    const parent = await revParse(bare, `${job.candidateSha}^`)
    if (parent !== job.expectedTargetSha) return { kind: 'integration_push', pushed: false, error: `Candidate ${job.candidateSha} isn't built on ${job.expectedTargetSha}` }
    const ref = `refs/heads/${job.targetBranch}`
    const push = await git(['push', `--force-with-lease=${ref}:${job.expectedTargetSha}`, 'origin', `${job.candidateSha}:${ref}`], { cwd: bare, timeoutMs: 2 * 60_000 })
    return { kind: 'integration_push', pushed: push.code === 0, error: push.code === 0 ? null : push.stderr.trim() || 'git push failed' }
  })
}

// What the remote says right now, from a fresh fetch
export async function inspectIntegration(dataDir: string, job: Job<'integration_inspect'>): Promise<Result<'integration_inspect'>> {
  const bare = await sync(dataDir, job.repository)
  return withRepoLock(bare, async () => {
    const targetSha = await revParse(bare, remoteRef(job.targetBranch))
    return { kind: 'integration_inspect', targetSha, integratedSha: targetSha ? await findIntegrated(bare, job.targetBranch, job.submissionId) : null }
  })
}
