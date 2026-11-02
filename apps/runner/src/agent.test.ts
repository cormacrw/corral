import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentEnv } from './agent.ts'
import { exec } from './exec.ts'

const AUTHOR = { name: 'Configured Person', email: 'configured@example.com' }

describe('agentEnv', () => {
  it('keeps GitHub tokens and pushing from the agent', () => {
    const env = agentEnv({ PATH: '/usr/bin', GH_TOKEN: 'secret', GIT_CONFIG_KEY_3: 'x' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GIT_CONFIG_KEY_3).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_0).toBe('no-push://corral-pushes-for-you')
  })

  it('leaves the production service mode out of agent commands', () => {
    expect(agentEnv({ NODE_ENV: 'production' }).NODE_ENV).toBeUndefined()
  })

  it('leaves out the runner\'s own Corral settings', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      CORRAL_SERVER_URL: 'http://server:4100',
      CORRAL_RUNNER_DATA_DIR: '/data/runner',
      CORRAL_RUNNER_NAME: 'home-server'
    })
    expect(Object.keys(env).filter(key => key.startsWith('CORRAL_'))).toEqual([])
  })

  it('sets the configured git author and committer, and leaves the settings out', () => {
    const env = agentEnv({ PATH: '/usr/bin', CORRAL_GIT_AUTHOR_NAME: AUTHOR.name, CORRAL_GIT_AUTHOR_EMAIL: AUTHOR.email }, AUTHOR)
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email
    })
    expect(Object.keys(env).filter(key => key.startsWith('CORRAL_'))).toEqual([])
  })

  it('sets no git identity when none is configured', () => {
    const env = agentEnv({ PATH: '/usr/bin' })
    expect(Object.keys(env).filter(key => key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_'))).toEqual([])
  })
})

describe('agent commits', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-agent-env-'))
    await mkdir(join(root, 'worktree'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // Runs git as the agent would: in the worktree, with agentEnv's environment
  // and a HOME of its own, so the machine's global git config plays no part
  async function git(args: string[]): Promise<string> {
    const env = agentEnv({ ...process.env, HOME: root, CORRAL_GIT_AUTHOR_NAME: AUTHOR.name, CORRAL_GIT_AUTHOR_EMAIL: AUTHOR.email }, AUTHOR)
    const result = await exec('git', args, { cwd: join(root, 'worktree'), env })
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  async function commitAndShowIdentity(): Promise<string> {
    await writeFile(join(root, 'worktree', 'README.md'), '# App\n')
    await git(['add', '.'])
    await git(['commit', '--quiet', '-m', 'Agent commit'])
    return git(['log', '-1', '--format=%an <%ae> / %cn <%ce>'])
  }

  it('cannot push through origin even when the repository config allows it', async () => {
    await git(['init', '--quiet', '--initial-branch', 'main'])
    await commitAndShowIdentity()
    const origin = join(root, 'origin.git')
    await git(['init', '--quiet', '--bare', origin])
    await git(['remote', 'add', 'origin', origin])
    await git(['config', 'remote.origin.pushurl', origin])
    await expect(git(['push', 'origin', 'HEAD:main'])).rejects.toThrow('no-push')
    // The same local-only path used by deployment fixtures remains usable.
    await git(['push', origin, 'HEAD:main'])
    expect(await git(['--git-dir', origin, 'rev-parse', 'main'])).toBe(await git(['rev-parse', 'HEAD']))
  })

  it('have the configured author and committer', async () => {
    await git(['init', '--quiet', '--initial-branch', 'main'])
    expect(await commitAndShowIdentity()).toBe('Configured Person <configured@example.com> / Configured Person <configured@example.com>')
  })

  it('keep the configured identity when the agent writes its own git config', async () => {
    await git(['init', '--quiet', '--initial-branch', 'main'])
    await git(['config', 'user.name', 'Other'])
    await git(['config', 'user.email', 'other@x'])
    expect(await commitAndShowIdentity()).toBe('Configured Person <configured@example.com> / Configured Person <configured@example.com>')
    expect(await git(['config', 'user.email'])).toBe('other@x')
  })
})
