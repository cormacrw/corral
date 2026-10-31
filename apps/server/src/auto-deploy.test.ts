import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const scripts = resolve(import.meta.dirname, '../../../scripts/deploy')
const exec = promisify(execFile)

const hasFlock = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// The scripts as a deployed checkout has them: untracked here, so `git checkout` leaves them
async function installScripts(checkout: string): Promise<void> {
  await mkdir(join(checkout, 'scripts/deploy'), { recursive: true })
  for (const name of ['auto-deploy.sh', 'backup.sh', 'build-sha.sh', 'compose.sh']) {
    await copyFile(join(scripts, name), join(checkout, 'scripts/deploy', name))
  }
  await mkdir(join(checkout, '.corral/deploy'), { recursive: true })
}

// flock is util-linux, so macOS has none; without one the lock line exits quietly
async function shimFlock(bin: string): Promise<void> {
  if (hasFlock) return
  await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
  await chmod(join(bin, 'flock'), 0o755)
}

// Runs the real scripts/deploy/auto-deploy.sh in a scratch checkout. docker
// runs `compose exec` commands locally, so the script's api helper talks to
// this test server; curl answers that CI passed; origin is a local bare repo
// standing in for github.com/<repository>.
describe('auto-deploy.sh reporting the deployment', () => {
  let t: TestApp
  let dir: string

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    dir = await mkdtemp(join(tmpdir(), 'corral-auto-deploy-'))
  })

  afterAll(async () => {
    await t?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('posts every commit of a range longer than 1,000 and stores them all', async () => {
    const project = await t.createProject()
    const origin = join(dir, 'origin.git')
    const checkout = join(dir, 'checkout')
    const bin = join(dir, 'bin')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

    // A, then 1,001 commits up to B, in one fast-import
    const count = 1001
    let stream = ''
    for (let i = 0; i <= count; i++) {
      const message = i === 0 ? 'A: already deployed' : `Change ${i} with "quotes" and \\ backslash`
      stream += `commit refs/heads/main\ncommitter T <t@example.com> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`
      stream += `M 644 inline file\ndata ${String(i).length}\n${i}\n\n`
    }
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
    execFileSync('git', ['fast-import', '--quiet'], { cwd: origin, input: stream })
    const remoteUrl = `https://github.com/${project.repository}.git`
    execFileSync('git', ['-c', `url.${origin}.insteadOf=${remoteUrl}`, 'clone', '--quiet', remoteUrl, checkout])
    git(checkout, 'config', `url.${origin}.insteadOf`, remoteUrl)
    const a = git(checkout, 'rev-list', '--max-parents=0', 'HEAD')
    const b = git(checkout, 'rev-parse', 'HEAD')

    await installScripts(checkout)
    await writeFile(join(checkout, '.corral/deploy/deployed'), `${a}\n`)

    await mkdir(bin)
    await writeFile(join(bin, 'docker'), [
      '#!/usr/bin/env bash',
      'if [ "$1 $2" = "compose exec" ]; then shift 4; exec "$@"; fi',
      'exit 0'
    ].join('\n'))
    await writeFile(join(bin, 'curl'), `#!/usr/bin/env bash\necho '{"check_runs":[{"status": "completed", "conclusion": "success"}]}'\n`)
    await chmod(join(bin, 'docker'), 0o755)
    await chmod(join(bin, 'curl'), 0o755)
    await shimFlock(bin)

    // Async, so this process's test server can answer the script
    const { stdout: output } = await exec(join(checkout, 'scripts/deploy/auto-deploy.sh'), [], {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CORRAL_SERVER_PORT: new URL(t.server!.url).port, CORRAL_DEPLOY_REPORT_TRIES: '2', CORRAL_DEPLOY_REPORT_WAIT: '0' }
    })
    expect(output).not.toContain('warning')
    expect((await readFile(join(checkout, '.corral/deploy/deployed'), 'utf8')).trim()).toBe(b)

    const rows = await t.db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
    expect(rows).toHaveLength(1)
    const deployment = rows[0]!
    expect(deployment.fromSha).toBe(a)
    expect(deployment.toSha).toBe(b)
    expect(deployment.commits).toHaveLength(count)
    expect(deployment.commits[0]).toEqual({ sha: b, subject: `Change ${count} with "quotes" and \\ backslash` })
    expect(deployment.commits.at(-1)!.subject).toBe('Change 1 with "quotes" and \\ backslash')
    expect(deployment.commits.map(c => c.sha)).toEqual(git(checkout, 'rev-list', `${a}..${b}`).split('\n'))
  }, 60_000)
})

// Everything docker does here is decided by FAKE_* variables and logged, one
// line per call with the build SHA, so a test reads what the script decided.
// The hold polls answer from the `hold` file, one line each: `fail` is a failed
// call, and once the lines run out nothing is busy.
const fakeDocker = String.raw`#!/usr/bin/env bash
log() { echo "$*" >>"$FAKE/log"; }
case "$*" in
  'compose exec -T server node '*)
    cat >/dev/null
    method=$(grep -oE "method: '[A-Z]+'" <<<"$*" | cut -d"'" -f2)
    path=$(grep -oE "'/api[^']*'" <<<"$*" | tr -d "'")
    log "api $method $path"
    [ "$FAKE_SERVER" != down ] || exit 1
    if [ "$method $path" = 'POST /api/update-hold' ] && [ -s "$FAKE/hold" ]; then
      line=$(head -n 1 "$FAKE/hold")
      sed -i.bak 1d "$FAKE/hold"
      [ "$line" != fail ] || exit 1
      echo "$line"
    else
      echo '{"busy":0}'
    fi
    exit 0 ;;
  'compose exec -T postgres pg_dump'*) log "dump"; echo dump; exit 0 ;;
esac
log "docker $* SHA=$CORRAL_BUILD_SHA"
case "$*" in
  'compose config --services') echo server ;;
  'compose ps -q server') [ -z "$FAKE_RUNNING_IMAGE" ] || echo container ;;
  'inspect -f {{index .Config.Labels "com.docker.compose.config-hash"}} container') echo hash ;;
  'compose config --hash server') echo 'server hash' ;;
  'compose config --images server') echo corral-server ;;
  'inspect -f {{.Image}} container') echo "$FAKE_RUNNING_IMAGE" ;;
  'image inspect -f {{.Id}} corral-server') echo "$FAKE_BUILT_IMAGE" ;;
  'compose build') exit "\${FAKE_BUILD_EXIT:-0}" ;;
  'compose up'*) exit "\${FAKE_UP_EXIT:-0}" ;;
  'image prune -f') exit "\${FAKE_PRUNE_EXIT:-0}" ;;
  'compose run'*)
    if [ -n "$FAKE_RUN_JUNK" ]; then echo junk; else gzip -c <<<blobs; fi
    exit "\${FAKE_RUN_EXIT:-0}" ;;
esac
exit 0
`.replaceAll('\\$', '$')

describe('auto-deploy.sh deciding what to do', { timeout: 30_000 }, () => {
  let dir: string
  let checkout: string
  let main: string[]

  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: checkout, encoding: 'utf8' }).trim()

  async function commit(path: string): Promise<string> {
    await mkdir(dirname(join(checkout, path)), { recursive: true })
    await writeFile(join(checkout, path), `${main.length}\n`)
    git('add', path)
    git('commit', '--quiet', '-m', `Change ${path}`)
    git('push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    const sha = git('rev-parse', 'HEAD')
    main.push(sha)
    return sha
  }

  async function run(name: 'auto-deploy.sh' | 'backup.sh', env: Record<string, string> = {}): Promise<{ code: number, output: string }> {
    try {
      const { stdout, stderr } = await exec(join(checkout, 'scripts/deploy', name), [], {
        cwd: checkout,
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAKE: dir, CORRAL_DEPLOY_HOLD_WAIT: '0', CORRAL_DEPLOY_REPORT_WAIT: '0', CORRAL_DEPLOY_REPORT_TRIES: '1', CORRAL_BACKUP_MIN_FREE_MB: '0', ...env }
      })
      return { code: 0, output: stdout + stderr }
    } catch (error) {
      const failed = error as { code: number, stdout: string, stderr: string }
      return { code: failed.code, output: failed.stdout + failed.stderr }
    }
  }
  const deploy = (env?: Record<string, string>) => run('auto-deploy.sh', env)

  const log = async () => (await readFile(join(dir, 'log'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const state = (name: string) => readFile(join(checkout, '.corral/deploy', name), 'utf8').then(s => s.trim(), () => null)
  const backups = () => readdir(join(checkout, '.corral/backups')).catch(() => [] as string[])
  const holdAnswers = (...lines: string[]) => writeFile(join(dir, 'hold'), lines.map(line => `${line}\n`).join(''))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corral-auto-deploy-'))
    checkout = join(dir, 'checkout')
    main = []
    await mkdir(join(dir, 'bin'))
    await writeFile(join(dir, 'bin/docker'), fakeDocker)
    await writeFile(join(dir, 'bin/curl'), `#!/usr/bin/env bash\necho "{\\"check_runs\\":[{\\"status\\": \\"completed\\", \\"conclusion\\": \\"\${FAKE_CI:-success}\\"}]}"\n`)
    await Promise.all(['docker', 'curl'].map(name => chmod(join(dir, 'bin', name), 0o755)))
    await shimFlock(join(dir, 'bin'))
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(dir, 'origin.git')])
    execFileSync('git', ['clone', '--quiet', join(dir, 'origin.git'), checkout], { stdio: 'ignore' })
    git('symbolic-ref', 'HEAD', 'refs/heads/main')
    await installScripts(checkout)
    await writeFile(join(checkout, '.corral/deploy/deployed'), `${await commit('apps/server/src/a.ts')}\n`)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps the build SHA and takes no hold for a commit that touches no backend input', async () => {
    const backend = await commit('apps/runner/src/b.ts')
    const docs = await commit('docs/c.md')

    const { code } = await deploy({ FAKE_RUNNING_IMAGE: 'image', FAKE_BUILT_IMAGE: 'image' })

    expect(code).toBe(0)
    expect(await log()).toContain(`docker compose build SHA=${backend}`)
    expect((await log()).filter(line => line.includes('/update-hold'))).toEqual([])
    expect(await state('deployed')).toBe(docs)
  })

  it('moves the build SHA for each file that goes into the images', async () => {
    for (const path of ['packages/core/src/d.ts', 'patches/e.patch', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'docker-compose.yml', '.dockerignore', 'deploy/runner/docker-compose.yml', 'scripts/deploy/runner-update-io.py']) {
      const sha = await commit(path)
      expect(execFileSync(join(checkout, 'scripts/deploy/build-sha.sh'), { encoding: 'utf8' }).trim(), path).toBe(sha)
    }
  })

  it('compose.sh passes the same SHA a deploy would', async () => {
    const backend = await commit('apps/server/src/f.ts')
    await commit('apps/web/g.vue')
    await exec(join(checkout, 'scripts/deploy/compose.sh'), ['build'], { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAKE: dir } })
    expect(await log()).toEqual([`docker compose build SHA=${backend}`])
  })

  it('holds and restarts when a backend image changed, and tags what was running', async () => {
    await commit('apps/server/src/h.ts')
    await holdAnswers('{"busy":1}', '{"busy":0}')

    await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new' })

    const lines = await log()
    expect(lines.filter(line => line === 'api POST /api/update-hold')).toHaveLength(2)
    expect(lines.filter(line => line.startsWith('docker image tag old corral-server:previous'))).toHaveLength(1)
    expect(lines.indexOf('api POST /api/update-hold')).toBeLessThan(lines.findIndex(line => line.startsWith('docker compose up')))
  })

  it('keeps waiting through a failed poll while runs are still busy', async () => {
    await commit('apps/server/src/i.ts')
    // The first answer is the hold itself, then the loop polls
    await holdAnswers('{"busy":2}', '{"busy":2}', 'fail', '{"busy":1}', '{"busy":0}')

    await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new' })

    expect((await log()).filter(line => line === 'api POST /api/update-hold')).toHaveLength(5)
    expect(await readFile(join(dir, 'hold'), 'utf8')).toBe('')
  })

  it.for([
    { name: 'failing', answer: 'fail' },
    { name: 'answering without a count', answer: 'not json' }
  ])('deploys once the server keeps $name during the hold', async ({ answer }) => {
    const sha = await commit('apps/server/src/j.ts')
    await holdAnswers('{"busy":1}', answer, answer, answer, answer, answer, '{"busy":1}')

    const { output } = await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new', CORRAL_DEPLOY_HOLD_FAILURES: '3' })

    expect(output).toContain('server stopped answering')
    expect(await state('deployed')).toBe(sha)
  })

  it('counts only consecutive failures against the server', async () => {
    await commit('apps/server/src/k.ts')
    await holdAnswers('{"busy":1}', 'fail', 'fail', '{"busy":1}', 'fail', 'fail', '{"busy":1}', '{"busy":0}')

    const { output } = await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new', CORRAL_DEPLOY_HOLD_FAILURES: '3' })

    expect(output).not.toContain('server stopped answering')
    expect(await readFile(join(dir, 'hold'), 'utf8')).toBe('')
  })

  it('deploys without a hold when the server is down', async () => {
    const sha = await commit('apps/server/src/l.ts')
    const { output } = await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new', FAKE_SERVER: 'down' })
    expect(output).toContain('server not reachable')
    expect(await state('deployed')).toBe(sha)
  })

  it('deploys a commit whose CI failed once a re-run passes, and logs the failure once', async () => {
    const sha = await commit('apps/server/src/m.ts')

    expect((await deploy({ FAKE_CI: 'failure' })).output).toContain('CI failed')
    expect((await deploy({ FAKE_CI: 'failure' })).output).toBe('')
    expect(await state('skipped')).toBe(sha)

    await deploy()
    expect(await state('deployed')).toBe(sha)
  })

  it('retries a failed build a few times, then waits for a new commit', async () => {
    const failing = await commit('apps/server/src/n.ts')
    const builds = async () => (await log()).filter(line => line.startsWith('docker compose build')).length

    for (let tick = 0; tick < 4; tick++) await deploy({ FAKE_BUILD_EXIT: '1', CORRAL_DEPLOY_BUILD_TRIES: '2' })
    expect(await builds()).toBe(2)
    expect(await state('deployed')).not.toBe(failing)

    const fixed = await commit('apps/server/src/o.ts')
    await deploy({ CORRAL_DEPLOY_BUILD_TRIES: '2' })
    expect(await builds()).toBe(3)
    expect(await state('deployed')).toBe(fixed)
    expect(await state('build-failures')).toBeNull()
  })

  it('deploys after a build that failed once and then succeeds', async () => {
    const sha = await commit('apps/server/src/p.ts')
    expect((await deploy({ FAKE_BUILD_EXIT: '1' })).code).toBe(1)
    await deploy()
    expect(await state('deployed')).toBe(sha)
  })

  it('does not count a deploy that never came up healthy, lifts the hold and tries again', async () => {
    const before = await state('deployed')
    const sha = await commit('apps/server/src/q.ts')

    const failed = await deploy({ FAKE_RUNNING_IMAGE: 'old', FAKE_BUILT_IMAGE: 'new', FAKE_UP_EXIT: '1' })

    expect(failed.code).toBe(1)
    expect(await state('deployed')).toBe(before)
    const lines = await log()
    expect(lines.find(line => line.startsWith('docker compose up'))).toContain('--wait')
    expect(lines).toContain('api DELETE /api/update-hold')
    expect(lines).not.toContain('api POST /api/deployments')
    expect(lines.filter(line => line.startsWith('docker image prune'))).toEqual([])

    // The retry runs the target already, so :previous still names the good image
    await deploy({ FAKE_RUNNING_IMAGE: 'new', FAKE_BUILT_IMAGE: 'new' })
    expect(await state('deployed')).toBe(sha)
    expect((await log()).filter(line => line.startsWith('docker image tag'))).toHaveLength(1)
  })

  it('records the deploy even if pruning images fails', async () => {
    const sha = await commit('apps/server/src/r.ts')
    const { code, output } = await deploy({ FAKE_PRUNE_EXIT: '1' })
    expect(code).toBe(0)
    expect(output).toContain('could not prune')
    expect(await state('deployed')).toBe(sha)
    expect(await log()).toContain('api POST /api/deployments')
  })

  it('backs up without the server before a deploy with migrations, once across retries', async () => {
    const sha = await commit('packages/db/migrations/0099_new.sql')

    await deploy({ FAKE_SERVER: 'down', FAKE_UP_EXIT: '1' })
    expect((await log()).filter(line => line.includes('tar'))).toHaveLength(1)
    expect((await log()).find(line => line.includes('tar'))).toContain('compose run --rm --no-deps -T')
    expect(await backups()).toHaveLength(2)

    await deploy({ FAKE_SERVER: 'down' })
    expect(await backups()).toHaveLength(2)
    expect(await state('deployed')).toBe(sha)
  })

  it('stops the deploy when the backup in front of it fails', async () => {
    const before = await state('deployed')
    await commit('packages/db/migrations/0100_new.sql')

    const { code, output } = await deploy({ FAKE_RUN_EXIT: '2' })

    expect(code).toBe(1)
    expect(output).toContain('backup failed')
    expect(await state('deployed')).toBe(before)
    expect((await log()).filter(line => line.startsWith('docker compose up'))).toEqual([])
    expect((await backups()).filter(name => name.endsWith('.partial'))).toEqual([])
  })

  describe('backup.sh', () => {
    it('keeps the archive when tar reports files changed while it read them', async () => {
      const { code, output } = await run('backup.sh', { FAKE_RUN_EXIT: '1' })
      expect(code).toBe(0)
      expect(output).toContain('files changed during the blob backup')
      expect((await backups()).filter(name => name.startsWith('server-data-') && name.endsWith('-nightly.tar.gz'))).toHaveLength(1)
    })

    it('fails on a compose error that left no readable archive, and cleans up', async () => {
      const { code } = await run('backup.sh', { FAKE_RUN_EXIT: '1', FAKE_RUN_JUNK: '1' })
      expect(code).toBe(1)
      expect((await backups()).filter(name => name.startsWith('server-data-'))).toEqual([])
      expect((await backups()).filter(name => name.endsWith('.partial'))).toEqual([])
    })

    it('removes a partial file left by a killed run', async () => {
      await mkdir(join(checkout, '.corral/backups'), { recursive: true })
      await writeFile(join(checkout, '.corral/backups/postgres-old-nightly.dump.partial'), 'cut short')
      await run('backup.sh')
      expect((await backups()).filter(name => name.endsWith('.partial'))).toEqual([])
    })

    it('refuses to run with too little free space', async () => {
      const { code, output } = await run('backup.sh', { CORRAL_BACKUP_MIN_FREE_MB: String(2 ** 40) })
      expect(code).toBe(1)
      expect(output).toContain('not backing up')
      expect(await log()).toEqual([])
    })

    it('waits for the deploy lock and gives up rather than running during a deploy', async ({ skip }) => {
      if (!hasFlock) skip('needs flock from util-linux, which macOS does not have')
      const lock = join(checkout, '.corral/deploy/lock')
      const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' })
      try {
        await vi.waitFor(async () => {
          const free = await exec('flock', ['-n', lock, 'true']).then(() => true, () => false)
          if (free) throw new Error('not held yet')
        })
        const { code, output } = await run('backup.sh', { CORRAL_BACKUP_LOCK_WAIT: '0' })
        expect(code).toBe(1)
        expect(output).toContain('held the lock')
        expect(await log()).toEqual([])
      } finally {
        holder.kill()
      }
    })
  })
})
