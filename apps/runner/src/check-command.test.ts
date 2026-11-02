import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { checkCpus } from '../../../scripts/check-cpus.ts'

const exec = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'corral-check-'))
  directories.push(cwd)
  await mkdir(join(cwd, 'bin'))
  await exec('git', ['init'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'fixture'], { cwd })
  await writeFile(join(cwd, '.git', 'info', 'exclude'), 'bin/\ncalls\n.corral/checks/\n')
  await writeFile(join(cwd, 'bin', 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('calls', JSON.stringify({ args: process.argv.slice(2), cpus: process.env.CORRAL_CHECK_CPUS, force: process.env.TURBO_FORCE, workers: process.env.VITEST_MAX_WORKERS, nodeEnv: process.env.NODE_ENV }) + '\\n');
if (process.argv.includes(process.env.FAIL_STAGE)) process.exit(7);
`, { mode: 0o755 })
  const run = (args: string[] = [], extra = {}) => exec(process.execPath, [resolve(import.meta.dirname, '../../../scripts/check.ts'), ...args], {
    cwd, env: { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}`, ...extra }
  })
  const calls = async () => (await readFile(join(cwd, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { cwd, run, calls }
}

test('validates a single positive CPU setting', () => {
  expect(checkCpus('2')).toBe(2)
  for (const value of ['0', '-1', '1.5', '', 'abc', 'Infinity']) expect(() => checkCpus(value)).toThrow('positive integer')
})

test('runs all workspace gates at the shared cap and includes root checks', async () => {
  const { run, calls } = await fixture()
  await run([], { CORRAL_CHECK_CPUS: '2', VITEST_MAX_WORKERS: '99', NODE_ENV: 'production' })
  expect((await calls()).every(call => call.nodeEnv === undefined)).toBe(true)
  expect(await calls()).toEqual([
    expect.objectContaining({ args: ['exec', 'turbo', 'run', 'lint', 'typecheck', 'test', '--concurrency=2'], cpus: '2', workers: '2' }),
    expect.objectContaining({ args: ['exec', 'eslint', 'scripts'] }),
    expect.objectContaining({ args: ['exec', 'tsc'] })
  ])
})

test.each(['lint', 'typecheck', 'test', 'eslint', 'tsc'])('propagates %s failure without saving a clean result', async (stage) => {
  const { run, calls } = await fixture()
  await expect(run(['--review'], { FAIL_STAGE: stage })).rejects.toThrow()
  await run(['--review'])
  expect((await calls()).filter(c => c.args.includes('turbo'))).toHaveLength(2)
})

test('only reuses a clean review check for the same clean head and cites its run', async () => {
  const { cwd, run, calls } = await fixture()
  await run() // A developer run is never eligible.
  const first = await run(['--review'])
  const id = first.stdout.match(/Saved clean review check run (\S+)/)?.[1]
  expect(id).toBeTruthy()
  expect((await calls())[3].force).toBe('1')
  const second = await run(['--review'])
  expect(second.stdout).toContain(`Reused clean review check run ${id}`)
  expect(await calls()).toHaveLength(6)
  await writeFile(join(cwd, 'dirty'), 'untracked change')
  await run(['--review'])
  expect(await calls()).toHaveLength(9)
  await exec('git', ['add', 'dirty'], { cwd })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'new head'], { cwd })
  expect((await run(['--review'])).stdout).toContain('Saved clean review check run')
  expect(await calls()).toHaveLength(12)
})

// Isolated Vitest workers used to free their slot before graceful process exit.
// Delaying SIGTERM reproduces the overlap reliably instead of relying on timing
// in a large suite. Each worker records entry and exit from its own process.
test('holds the worker cap while isolated workers are exiting', async () => {
  const { cwd } = await fixture()
  await symlink(resolve(import.meta.dirname, '../node_modules'), join(cwd, 'node_modules'), 'dir')
  const events = join(cwd, 'worker-events')
  const source = `import { test } from 'vitest'
import { appendFileSync } from 'node:fs'
const record = (event) => appendFileSync(${JSON.stringify(events)}, event + process.pid + '\\n')
record('+')
process.on('exit', () => record('-'))
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250))
test('passing worker', () => {})
`
  await writeFile(join(cwd, 'vitest.config.mjs'), 'export default { test: { maxWorkers: 2 } }')
  await Promise.all(Array.from({ length: 6 }, (_, i) => writeFile(join(cwd, `${i}.test.mjs`), source)))
  const vitest = fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')))
  await exec(process.execPath, [vitest, 'run'], { cwd, timeout: 15_000 })
  const active = new Set<string>()
  let maximum = 0
  for (const event of (await readFile(events, 'utf8')).trim().split('\n')) {
    if (event.startsWith('+')) active.add(event.slice(1))
    else active.delete(event.slice(1))
    maximum = Math.max(maximum, active.size)
  }
  expect(maximum).toBe(2)
  expect(active.size).toBe(0)
}, 20_000)
