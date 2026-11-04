// `pnpm seed:demo`: builds a demo data dir with projects, tasks in every
// state, Inbox items, Plan conversations and agent history, by driving the
// real server through its flows (harness.ts). `pnpm dev:demo` runs it on first
// start. The finished dir is moved into place at the end, so an interrupted
// seed never leaves half a demo behind.
//
//   node apps/server/src/demo/seed.ts [--data-dir <dir>] [--force]
//
// The default dir is .corral/demo/server in this checkout. --force replaces
// an existing demo there.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Seeder } from './harness.ts'
import { seedDemo } from './scenarios.ts'

const root = resolve(import.meta.dirname, '..', '..', '..', '..')
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'force': { type: 'boolean', default: false } } })
const dataDir = resolve(values['data-dir'] ?? join(root, '.corral', 'demo', 'server'))
const building = `${dataDir}.seeding`

if (existsSync(dataDir) && !values.force) {
  console.error(`${dataDir} already exists. Pass --force to replace it with a fresh demo.`)
  process.exit(1)
}

// PGlite has one process per data dir: replacing it under a running server
// would lose the seed or corrupt the database
if (!process.env.CORRAL_DEMO_SEEDING_FOR_DEV) {
  try {
    const instance = JSON.parse(readFileSync(join(root, '.corral', 'dev.json'), 'utf8')) as { pid: number, serverDataDir: string }
    if (resolve(instance.serverDataDir) === dataDir && isRunning(instance.pid)) {
      console.error(`A dev server (pid ${instance.pid}) is using ${dataDir}. Stop it first, or run \`pnpm dev:demo --reseed\`.`)
      process.exit(1)
    }
  } catch {
    // No dev.json: nothing is running from this checkout
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const started = performance.now()
await rm(building, { recursive: true, force: true })
await mkdir(building, { recursive: true })
const seeder = await Seeder.open(building, process.env.CORRAL_PUBLIC_URL || 'http://localhost:3000')
try {
  await seedDemo(seeder)
  seeder.github.save(join(building, 'demo-github.json'))
} finally {
  await seeder.close()
}
await mkdir(dirname(dataDir), { recursive: true })
await rm(dataDir, { recursive: true, force: true })
await rename(building, dataDir)
console.log(`Seeded the demo in ${((performance.now() - started) / 1000).toFixed(1)} s: ${dataDir}`)
// Timers in the services (leases, polling) would keep the process alive
process.exit(0)
