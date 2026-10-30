import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'

// Exercise the public root command, including Turbo and each package script.
// Keep fixtures temporary so the ordinary suite never contains intentional failures.
const packages = [
  ['apps/server', '@corral/server'],
  ['packages/db', '@corral/db'],
  ['apps/runner', '@corral/runner'],
  ['apps/web', '@corral/web'],
  ['packages/core', '@corral/core'],
  ['packages/contracts', '@corral/contracts']
] as const
const assertion = 'import { test, expect } from \'vitest\'; test(\'exit assertion probe\', () => expect(\'actual\').toBe(\'expected\'))'
const probes = [
  ...packages.map(([dir, name]) => ({ dir, name, label: 'assertion', source: assertion, diagnostic: /exit assertion probe/, fails: true })),
  ...packages.slice(0, 2).map(([dir, name]) => ({
    dir, name, label: 'worker kill',
    source: 'import { test } from \'vitest\'; test(\'exit kill probe\', () => process.kill(process.pid, \'SIGKILL\'))',
    diagnostic: /SIGKILL/, fails: true
  })),
  {
    dir: 'apps/server', name: '@corral/server', label: 'hook timeout',
    source: 'import { beforeAll, test } from \'vitest\'; beforeAll(() => new Promise(() => {}), 50); test(\'exit hook probe\', () => {})',
    diagnostic: /Hook timed out/, fails: true
  },
  {
    dir: 'apps/server', name: '@corral/server', label: 'passing control',
    source: 'import { test, expect } from \'vitest\'; test(\'exit passing probe\', () => expect(1).toBe(1))',
    diagnostic: /1 passed/, fails: false
  }
]
for (const probe of probes) {
  const path = `${probe.dir}/corral-exit-status-probe.test.ts`
  // Exclusive creation prevents overwriting a developer's file.
  await writeFile(path, probe.source, { flag: 'wx' })
  try {
    const result = await new Promise<{ code: number | null, signal: NodeJS.Signals | null, output: string }>((resolve, reject) => {
      const child = spawn('pnpm', ['run', 'test', `--filter=${probe.name}`, '--', 'corral-exit-status-probe.test.ts'], {
        env: { ...process.env, FORCE_COLOR: '0' },
        timeout: 120_000
      })
      let output = ''
      child.stdout.on('data', (data) => {
        output += data
      })
      child.stderr.on('data', (data) => {
        output += data
      })
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal, output }))
    })
    if (result.signal || result.code === null || (probe.fails ? result.code === 0 : result.code !== 0)
      || !probe.diagnostic.test(result.output)
      || (probe.fails && !result.output.includes(`${probe.name}#test`))) {
      throw new Error(`${probe.name} ${probe.label}: unexpected exit ${result.code}/${result.signal}\n${result.output}`)
    }
    console.log(`${probe.name}: ${probe.label}: exit ${result.code} (expected)`)
  } finally {
    await unlink(path)
  }
}
