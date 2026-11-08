import type { SetupJob, SetupJobResult } from '@corral/contracts'
import { errorText } from '@corral/core'
import { FALLBACK_COMMITTER, type GitAuthor } from './config.ts'
import { openRepo, remoteRef, type Repo } from './repos.ts'

type Job<K extends SetupJob['kind']> = Extract<SetupJob, { kind: K }>
type Result<K extends SetupJob['kind']> = Extract<SetupJobResult, { kind: K }>

// PR-free integration runs in the bare clone: nothing here needs a worktree, so
// the task's own worktree and branch stay exactly as they were reviewed (D27).

// The trailer survives the epic branch being rebased, so a submission is found
// on the remote whatever its commit's SHA has become
const submissionTrailer = (submissionId: string) => `Corral-Submission: ${submissionId}`

async function findIntegrated(repo: Repo, targetBranch: string, submissionId: string): Promise<string | null> {
  const found = await repo.required(['log', '-1', '--format=%H', '--fixed-strings', `--grep=${submissionTrailer(submissionId)}`, remoteRef(targetBranch)])
  return found || null
}

// One commit on top of the expected epic head holding the submission's own
// change, three-way merged when the epic moved. A squash of the task, parented
// on its base, is what's merged: `merge-tree --merge-base` needs git 2.40, and
// the task's commits stay out of the shared history either way. A rebase of the
// epic takes the base out of its history, so the epic's tree goes in on a commit
// parented on the same base: that keeps the base the merge's, and the merge
// about this task's change alone, not the epic's old commits against its new ones.
async function buildCandidate(repo: Repo, author: GitAuthor | null, job: Job<'integration_prepare'>): Promise<Result<'integration_prepare'>> {
  const prepared = (status: Result<'integration_prepare'>['status'], commitSha: string | null = null, files: string[] = []) =>
    ({ kind: 'integration_prepare' as const, status, targetSha: job.expectedTargetSha, commitSha, files })
  const [name, email] = (await repo.required(['log', '-1', '--format=%an%x00%ae', job.headSha])).split('\0') as [string, string]
  const committer = author ?? FALLBACK_COMMITTER
  const env = {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: job.committedAt,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: job.committedAt
  }
  const squash = await repo.required(['commit-tree', `${job.headSha}^{tree}`, '-p', job.baseSha, '-F', '-'], { input: job.message, env })
  const ours = await repo.required(['commit-tree', `${job.expectedTargetSha}^{tree}`, '-p', job.baseSha, '-m', 'Epic head'], { env })
  const merged = await repo.git(['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, squash])
  if (merged.code !== 0 && merged.code !== 1) throw new Error(merged.stderr.trim() || 'git merge-tree failed')
  const [tree, ...conflicted] = merged.stdout.split('\n').filter(Boolean)
  if (merged.code === 1) return prepared('conflict', null, conflicted)
  if (tree === await repo.required(['rev-parse', `${job.expectedTargetSha}^{tree}`])) return prepared('empty')
  const candidate = await repo.required(['commit-tree', tree!, '-p', job.expectedTargetSha, '-F', '-'], { input: job.message, env })
  return prepared('prepared', candidate)
}

// Changes no shared ref. An already integrated submission is reported rather
// than rebuilt, so a retry after a lost answer can't add a second commit. A
// candidate that can't be built is the submission's problem and comes back as
// `failed`; a throw means the runner couldn't reach the remote, which says
// nothing about the submission.
export async function prepareIntegration(dataDir: string, author: GitAuthor | null, job: Job<'integration_prepare'>): Promise<Result<'integration_prepare'>> {
  const repo = await openRepo(dataDir, job.repository).synced()
  return repo.withLock(async () => {
    const target = await repo.revParse(remoteRef(job.targetBranch))
    if (!target) throw new Error(`Branch ${job.targetBranch} doesn't exist`)
    const integrated = await findIntegrated(repo, job.targetBranch, job.submissionId)
    if (integrated) return { kind: 'integration_prepare', status: 'integrated', targetSha: target, commitSha: integrated, files: [] }
    if (target !== job.expectedTargetSha) return { kind: 'integration_prepare', status: 'moved', targetSha: target, commitSha: null, files: [] }
    const built = await buildCandidate(repo, author, job).catch((error: unknown) => ({
      kind: 'integration_prepare' as const, status: 'failed' as const, targetSha: target, commitSha: null, files: [], error: errorText(error)
    }))
    if (built.status === 'prepared' && job.candidateRef) await repo.required(['push', '--force', 'origin', `${built.commitSha}:refs/heads/${job.candidateRef}`])
    return built
  })
}

// A compare-and-swap push. Any failure, a timeout included, is for inspect to settle.
export async function pushIntegration(dataDir: string, job: Job<'integration_push'>): Promise<Result<'integration_push'>> {
  const repo = openRepo(dataDir, job.repository)
  return repo.withLock(async () => {
    const parent = await repo.revParse(`${job.candidateSha}^`)
    if (parent !== job.expectedTargetSha) return { kind: 'integration_push', pushed: false, error: `Candidate ${job.candidateSha} isn't built on ${job.expectedTargetSha}` }
    return { kind: 'integration_push', ...await repo.casPush(job.targetBranch, job.expectedTargetSha, job.candidateSha) }
  })
}

// What the remote says right now, from a fresh fetch
export async function inspectIntegration(dataDir: string, job: Job<'integration_inspect'>): Promise<Result<'integration_inspect'>> {
  const repo = await openRepo(dataDir, job.repository).synced()
  return repo.withLock(async () => {
    const targetSha = await repo.revParse(remoteRef(job.targetBranch))
    return { kind: 'integration_inspect', targetSha, integratedSha: targetSha ? await findIntegrated(repo, job.targetBranch, job.submissionId) : null }
  })
}
