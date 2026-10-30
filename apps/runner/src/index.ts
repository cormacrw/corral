import { printReady, shortenHome } from './banner.ts'
import { gitAuthorWarning, loadConfig } from './config.ts'
import { ServerConnection } from './connection.ts'
import { loadRunnerId } from './identity.ts'
import { runSetupJob, signedInRuntimes } from './jobs.ts'
import { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { installSkills, pinnedSkillsDir, skillTargets } from './skills.ts'

const config = loadConfig()
const warning = gitAuthorWarning(config)
if (warning) console.warn(`Warning: ${warning}`)
await installSkills(pinnedSkillsDir, skillTargets())
const runnerId = await loadRunnerId(config.dataDir)
const tools = new ToolServer()
await tools.start()

let announced = false
const connection: ServerConnection = new ServerConnection(config.serverUrl, { runnerId, name: config.name }, {
  activeRuns: () => runs.activeRuns(),
  capacity: async () => ({ slots: config.slots, roles: config.roles, runtimes: await signedInRuntimes(config) }),
  onStatus(status, detail) {
    if (status === 'connected') {
      printReady('Corral runner connected', {
        Server: config.serverUrl.href,
        Name: config.name,
        Takes: `${config.roles.join(', ')} (${config.slots} at once)`,
        Data: shortenHome(config.dataDir)
      })
      announced = true
    } else if (announced) {
      console.log(`Runner lost the server (${detail}); reconnecting…`)
      announced = false
    }
  },
  onMessage(message) {
    if (message.type === 'job.request') {
      runSetupJob(config, message.job, planSessionId => runs.pmTurnRunning(planSessionId)).then(
        result => connection.send({ type: 'job.result', jobId: message.jobId, ok: true, result }),
        (error: unknown) => connection.send({ type: 'job.result', jobId: message.jobId, ok: false, error: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    runs.handle(message)
  }
}, config.runnerToken)
const runs = new RunManager(config, connection, tools)
connection.start()

// Docker sends SIGTERM on stop: agents get the grace period, then the
// server hears the runs were interrupted (PRD §9.3)
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    void runs.shutdown().finally(() => {
      connection.close()
      void tools.close().finally(() => process.exit(0))
    })
  })
}
