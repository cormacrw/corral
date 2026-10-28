// `pnpm dev`: starts web, server and runner for this checkout. Several
// checkouts (e.g. agents in separate worktrees) can run at once: each gets its
// own data dir under .corral/ and its own ports, written to .corral/dev.json
// so tools and agents can find this instance.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const instanceDir = join(root, '.corral')
const host = '127.0.0.1'

// Prefer the usual ports so a single instance stays predictable
const serverPort = await pickPort(process.env.CORRAL_SERVER_PORT, 4100)
const webPort = await pickPort(process.env.CORRAL_WEB_PORT, 3000)
const serverUrl = `http://${host}:${serverPort}`

const env = {
  ...process.env,
  CORRAL_SERVER_HOST: host,
  CORRAL_SERVER_PORT: String(serverPort),
  CORRAL_SERVER_URL: serverUrl,
  CORRAL_WEB_PORT: String(webPort),
  CORRAL_SERVER_DATA_DIR: process.env.CORRAL_SERVER_DATA_DIR || join(instanceDir, 'server'),
  CORRAL_RUNNER_DATA_DIR: process.env.CORRAL_RUNNER_DATA_DIR || join(instanceDir, 'runner')
}

const instance = {
  pid: process.pid,
  webUrl: `http://localhost:${webPort}`,
  serverUrl,
  serverDataDir: env.CORRAL_SERVER_DATA_DIR,
  runnerDataDir: env.CORRAL_RUNNER_DATA_DIR
}
await mkdir(instanceDir, { recursive: true })
await writeFile(join(instanceDir, 'dev.json'), JSON.stringify(instance, null, 2) + '\n')
console.log(`corral dev: web ${instance.webUrl}, server ${serverUrl} (details in .corral/dev.json)`)

const turbo = spawn('turbo', ['run', 'dev', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => turbo.kill(signal))
}
turbo.on('exit', code => process.exit(code ?? 1))

// An explicitly configured port must be free; otherwise fall back from the
// preferred port to any free one
async function pickPort(configured: string | undefined, preferred: number): Promise<number> {
  if (configured) {
    const port = Number(configured)
    if (!(await isFree(port))) throw new Error(`Port ${port} is already in use`)
    return port
  }
  return (await isFree(preferred)) ? preferred : freePort()
}

// Nuxt listens on `localhost`, which can be ::1 rather than 127.0.0.1, so a
// port is only free if both loopback addresses are
async function isFree(port: number): Promise<boolean> {
  for (const address of ['127.0.0.1', '::1']) {
    if (!(await canListen(port, address))) return false
  }
  return true
}

function canListen(port: number, address: string): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => resolvePort(error.code === 'EADDRNOTAVAIL'))
    probe.listen(port, address, () => probe.close(() => resolvePort(true)))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      probe.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('No free port')))
    })
  })
}
