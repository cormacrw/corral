import EmbeddedPostgres from 'embedded-postgres'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attemptAll, operationError, runAll } from './failures.ts'

// Explicit opt-in utility for checking the Postgres suites locally. This is
// deliberately NOT a Vitest global setup: D14 requires a URL to run those suites.
export async function startTestPostgres(options: { port?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'corral-test-pg-'))
  let postgres: EmbeddedPostgres | undefined
  let output = ''
  const capture = (message: unknown) => {
    output = (output + String(message)).slice(-16_384)
  }
  const cleanup = [
    () => stop(postgres),
    () => rm(dataDir, { recursive: true, force: true })
  ]
  try {
    const port = options.port ?? await freePort()
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      postgresFlags: ['-h', '127.0.0.1'],
      onLog: capture,
      onError: capture
    })
    await postgres.initialise()
    await postgres.start()
    return {
      url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
      close: () => runAll('Stopping test Postgres', '', cleanup)
    }
  } catch (error) {
    throw operationError(`Starting test Postgres in ${dataDir}\n${output}`, error ?? new Error('Postgres exited before reporting readiness'), await attemptAll(cleanup))
  }
}

async function stop(postgres: EmbeddedPostgres | undefined): Promise<void> {
  // embedded-postgres.stop() waits for an exit event even if startup already
  // exited. Its child is needed here to handle that case and bound shutdown.
  const instance = postgres as unknown as { process?: ChildProcess } | undefined
  const child = instance?.process
  if (!instance || !child) return
  if (child.exitCode !== null || child.signalCode !== null) {
    delete instance.process
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.kill('SIGINT')
  })
  // Its exit hook must not try to stop an already-reaped child either.
  delete instance.process
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port')))
    })
  })
}
