import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { execFile, execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const script = resolve(import.meta.dirname, '../../../scripts/deploy/auto-deploy.sh')

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

    await mkdir(join(checkout, 'scripts/deploy'), { recursive: true })
    await copyFile(script, join(checkout, 'scripts/deploy/auto-deploy.sh'))
    await mkdir(join(checkout, '.corral/deploy'), { recursive: true })
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

    // Async, so this process's test server can answer the script
    const { stdout: output } = await promisify(execFile)(join(checkout, 'scripts/deploy/auto-deploy.sh'), [], {
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
