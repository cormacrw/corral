import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunJob } from '@corral/contracts'
import { exec } from './exec.ts'
import { barePath } from './repos.ts'

export const TEST_REPOSITORY = 'acme/app'

async function run(args: string[], cwd?: string): Promise<void> {
  const result = await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd ? { cwd } : {})
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

// A data dir whose bare clone of TEST_REPOSITORY already exists and fetches
// from a local repository, so tests never reach GitHub
export async function createTestDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corral-runner-'))
  const origin = join(root, 'origin')
  await mkdir(origin)
  await run(['init', '--quiet', '--initial-branch', 'main'], origin)
  await writeFile(join(origin, 'README.md'), '# App\n')
  await run(['add', '.'], origin)
  await run(['commit', '--quiet', '-m', 'Initial commit'], origin)

  const dataDir = join(root, 'data')
  const bare = barePath(dataDir, TEST_REPOSITORY)
  await mkdir(join(dataDir, 'repos'), { recursive: true })
  await run(['clone', '--quiet', '--bare', origin, bare])
  await run(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], bare)
  return dataDir
}

// Test-only fixture builder also supports malformed jobs for defensive workspace checks.
export function pmJob(overrides: Partial<{ [K in keyof RunJob]: RunJob[K] }> = {}): RunJob {
  return {
    runId: 'run-1',
    runNumber: 1,
    leaseEpoch: 1,
    role: 'pm',
    runtime: 'claude-code',
    projectId: 'project-1',
    repository: TEST_REPOSITORY,
    defaultBranch: 'main',
    taskId: null,
    taskRef: null,
    branch: null,
    headSha: null,
    planSessionId: 'session-1',
    agentSessionId: null,
    prompt: 'Hello',
    fallbackPrompt: null,
    model: null,
    timeoutSeconds: 60,
    ...overrides
  } as RunJob
}
