import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
fs.appendFileSync('calls', JSON.stringify({ args: process.argv.slice(2), cpus: process.env.CORRAL_CHECK_CPUS, force: process.env.TURBO_FORCE }) + '\\n');
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
  await run([], { CORRAL_CHECK_CPUS: '2' })
  expect(await calls()).toEqual([
    expect.objectContaining({ args: ['exec', 'turbo', 'run', 'lint', 'typecheck', 'test', '--concurrency=2'], cpus: '2' }),
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
