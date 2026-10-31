import { execFile, execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)

const hasFlock = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// A test that runs runner-update.sh itself, which only exists on Linux hosts
function updaterIt(name: string, test: () => Promise<void>, timeout?: number) {
  it(name, async ({ skip }) => {
    if (!hasFlock) skip('runner-update.sh needs flock from util-linux, which macOS does not have')
    await test()
  }, timeout)
}

const dirs: string[] = []
const controllers: AbortController[] = []
const runs: Promise<unknown>[] = []
const servers: Server[] = []
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort())
  await Promise.allSettled(runs.splice(0))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture(options: { current?: boolean, busy?: boolean, fail?: boolean, auto?: boolean, forged?: boolean, untrusted?: boolean } = {}) {
  // Resolved because the updater refuses symlinks anywhere in a path, and the
  // temporary folder is behind one on macOS
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'host-updater-')))
  dirs.push(dir)
  await Promise.all(['scripts/deploy', 'deploy/runner', 'data', 'bin'].map(path => mkdir(join(dir, path), { recursive: true })))
  await copyFile(resolve('../../scripts/deploy/runner-update.sh'), join(dir, 'scripts/deploy/runner-update.sh'))
  await copyFile(resolve('../../scripts/deploy/runner-update-io.py'), join(dir, 'scripts/deploy/runner-update-io.py'))
  const target = 'a'.repeat(40)
  const server = createServer((request, response) => {
    if (request.url !== '/runner/version' || request.headers.authorization !== 'Bearer fixture-secret') {
      response.writeHead(401).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ commit: target }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const status = { commit: options.current ? target : 'b'.repeat(40), serverCommit: options.forged ? 'c'.repeat(40) : target, behind: !options.current, draining: options.auto !== false, updateRequested: false, idle: !options.busy, activeRunCount: options.busy ? 1 : 0 }
  await writeFile(join(dir, 'data/update-status.json'), JSON.stringify(status))
  await writeFile(join(dir, 'bin/git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FIXTURE/events"
if [ "$1" = merge-base ]; then ${options.untrusted ? 'exit 1' : 'exit 0'}; fi
# git status must print nothing
exit 0
`)
  await writeFile(join(dir, 'bin/docker'), `#!/bin/sh
if [ "$1" = inspect ]; then
  echo '${JSON.stringify([{ Mounts: [{ Destination: '/data/runner', Source: join(dir, 'data') }], Config: { Env: [`CORRAL_SERVER_URL=http://127.0.0.1:${address.port}`, 'CORRAL_RUNNER_TOKEN=fixture-secret', `CORRAL_BUILD_SHA=${status.commit}`] } }])}'
  exit 0
fi
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

updaterIt('builds the exact server commit, waits for terminal run reports, then replaces only the runner', async () => {
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

updaterIt('does nothing and logs when current', async () => {
  const f = await fixture({ current: true })
  expect((await f.run()).stdout).toContain('up to date')
  await expect(f.events()).rejects.toThrow('ENOENT')
})

updaterIt('leaves manual-only behind runners working', async () => {
  const f = await fixture({ auto: false })
  expect((await f.run()).stdout).toContain('automatic updates disabled')
  await expect(f.events()).rejects.toThrow('ENOENT')
})

updaterIt('reports a failed build without replacing the old container', async () => {
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

updaterIt('rejects a forged volume SHA before fetching or selecting deployment code', async () => {
  const f = await fixture({ forged: true })
  await expect(f.run()).rejects.toMatchObject({ stdout: expect.stringContaining('Untrusted runner target') })
  await expect(f.events()).rejects.toThrow('ENOENT')
})

updaterIt('rejects an authenticated server target outside reviewed main history', async () => {
  const f = await fixture({ untrusted: true })
  await expect(f.run()).rejects.toMatchObject({ stdout: expect.stringContaining('outside trusted origin/main') })
  expect(await f.events()).not.toContain('checkout')
  expect(await f.events()).not.toContain('docker compose')
})

updaterIt('does not overwrite or chmod host files through feedback symlinks', async () => {
  const f = await fixture()
  const sentinel = join(f.dir, 'host-file')
  await writeFile(sentinel, 'host sentinel', { mode: 0o600 })
  await symlink(sentinel, join(f.dir, 'data/updater-result.json.tmp'))
  await symlink(sentinel, join(f.dir, 'data/updater-result.json'))
  await f.run()
  expect(await readFile(sentinel, 'utf8')).toBe('host sentinel')
  expect((await stat(sentinel)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(join(f.dir, 'data/updater-result.json'), 'utf8')).state).toBe('restarting')
}, 20_000)

it('pins the feedback directory when a parent is concurrently replaced by a symlink', async () => {
  const f = await fixture()
  const outside = join(f.dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'updater-result.json'), 'host sentinel', { mode: 0o600 })
  const script = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('boundary', sys.argv[1])
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
data, outside = sys.argv[2:]
original = boundary.os.replace
def race(source, destination, **kwargs):
    os.rename(data, data + '-original')
    os.symlink(outside, data)
    original(source, destination, **kwargs)
boundary.os.replace = race
boundary.feedback(data, 'target', 'building', '', 'attempt')
`
  await exec('python3', ['-c', script, join(f.dir, 'scripts/deploy/runner-update-io.py'), join(f.dir, 'data'), outside])
  expect(await readFile(join(outside, 'updater-result.json'), 'utf8')).toBe('host sentinel')
  expect((await stat(join(outside, 'updater-result.json'))).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(join(f.dir, 'data-original/updater-result.json'), 'utf8')).state).toBe('building')
  await expect(exec('python3', [join(f.dir, 'scripts/deploy/runner-update-io.py'), 'feedback', join(f.dir, 'data'), 'target', 'failed', '', 'attempt'])).rejects.toThrow()
})

it('does not follow a temporary symlink swapped in before fchmod', async () => {
  const f = await fixture()
  const sentinel = join(f.dir, 'host-file')
  await writeFile(sentinel, 'host sentinel', { mode: 0o600 })
  const script = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('boundary', sys.argv[1])
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
data, sentinel = sys.argv[2:]
original = boundary.os.fchmod
def race(fd, mode):
    for name in os.listdir(data):
        if name.startswith('.updater-'):
            os.unlink(os.path.join(data, name))
            os.symlink(sentinel, os.path.join(data, name))
    original(fd, mode)
boundary.os.fchmod = race
boundary.feedback(data, 'target', 'building', '', 'attempt')
`
  await expect(exec('python3', ['-c', script, join(f.dir, 'scripts/deploy/runner-update-io.py'), join(f.dir, 'data'), sentinel])).rejects.toThrow()
  expect(await readFile(sentinel, 'utf8')).toBe('host sentinel')
  expect((await stat(sentinel)).mode & 0o777).toBe(0o600)
})
