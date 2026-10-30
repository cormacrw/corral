import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const dirs: string[] = []
const controllers: AbortController[] = []
const runs: Promise<unknown>[] = []
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort())
  await Promise.allSettled(runs.splice(0))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture(options: { current?: boolean, busy?: boolean, fail?: boolean, auto?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'host-updater-'))
  dirs.push(dir)
  await Promise.all(['scripts/deploy', 'deploy/runner', 'data', 'bin'].map(path => mkdir(join(dir, path), { recursive: true })))
  await copyFile(resolve('../../scripts/deploy/runner-update.sh'), join(dir, 'scripts/deploy/runner-update.sh'))
  const target = 'a'.repeat(40)
  const status = { commit: options.current ? target : 'b'.repeat(40), serverCommit: target, behind: !options.current, draining: options.auto !== false, updateRequested: false, idle: !options.busy, activeRunCount: options.busy ? 1 : 0 }
  await writeFile(join(dir, 'data/update-status.json'), JSON.stringify(status))
  await writeFile(join(dir, 'bin/git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FIXTURE/events"
# git status must print nothing
exit 0
`)
  await writeFile(join(dir, 'bin/docker'), `#!/bin/sh
if [ "$1" = inspect ]; then echo "$FIXTURE/data"; exit 0; fi
printf 'docker %s SHA=%s\\n' "$*" "$CORRAL_BUILD_SHA" >> "$FIXTURE/events"
case "$*" in
  *'build runner') ${options.fail ? 'exit 1' : 'exit 0'} ;;
  *'up -d'*) jq -e '.idle and .activeRunCount == 0' "$FIXTURE/data/update-status.json" >/dev/null || exit 99 ;;
esac
`)
  await Promise.all(['git', 'docker'].map(name => chmod(join(dir, 'bin', name), 0o755)))
  const controller = new AbortController()
  controllers.push(controller)
  return {
    dir, status,
    run: () => {
      const running = exec('bash', [join(dir, 'scripts/deploy/runner-update.sh')], { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FIXTURE: dir }, signal: controller.signal, timeout: 15_000 })
      runs.push(running)
      void running.catch(() => {}) // Cleanup owns errors if an earlier assertion fails.
      return running
    },
    events: () => readFile(join(dir, 'events'), 'utf8')
  }
}

it('builds the exact server commit, waits for terminal run reports, then replaces only the runner', async () => {
  const f = await fixture({ busy: true })
  const running = f.run()
  await expect.poll(f.events, { timeout: 10_000 }).toContain('build runner')
  expect(await f.events()).not.toContain('up -d')
  await writeFile(join(f.dir, 'data/update-status.json'), JSON.stringify({ ...f.status, idle: true, activeRunCount: 0 }))
  await running
  const events = await f.events()
  expect(events).toContain(`checkout --detach ${'a'.repeat(40)}`)
  expect(events).toContain(`up -d --no-build runner SHA=${'a'.repeat(40)}`)
}, 20_000)

it('does nothing and logs when current', async () => {
  const f = await fixture({ current: true })
  expect((await f.run()).stdout).toContain('up to date')
  await expect(f.events()).rejects.toThrow('ENOENT')
})

it('leaves manual-only behind runners working', async () => {
  const f = await fixture({ auto: false })
  expect((await f.run()).stdout).toContain('automatic updates disabled')
  await expect(f.events()).rejects.toThrow('ENOENT')
})

it('reports a failed build without replacing the old container', async () => {
  const f = await fixture({ fail: true })
  await expect(f.run()).rejects.toThrow()
  expect(await f.events()).not.toContain('up -d')
  const first = JSON.parse(await readFile(join(f.dir, 'data/updater-result.json'), 'utf8'))
  expect(first).toMatchObject({ state: 'failed', target: 'a'.repeat(40) })
  await expect(f.run()).rejects.toThrow()
  const retry = JSON.parse(await readFile(join(f.dir, 'data/updater-result.json'), 'utf8'))
  expect(retry.state).toBe('failed')
  expect(retry.attempt).not.toBe(first.attempt)
}, 20_000)
