import { printReady, shortenHome } from './banner.ts'
import { loadConfig } from './config.ts'
import { ServerConnection } from './connection.ts'
import { loadRunnerId } from './identity.ts'
import { runSetupJob } from './jobs.ts'

const config = loadConfig()
const runnerId = await loadRunnerId(config.dataDir)

let announced = false
const connection: ServerConnection = new ServerConnection(config.serverUrl, { runnerId, name: config.name }, {
  activeRuns: () => [],
  onStatus(status, detail) {
    if (status === 'connected') {
      printReady('Corral runner connected', {
        Server: config.serverUrl.href,
        Name: config.name,
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
      runSetupJob(config, message.job).then(
        result => connection.send({ type: 'job.result', jobId: message.jobId, ok: true, result }),
        (error: unknown) => connection.send({ type: 'job.result', jobId: message.jobId, ok: false, error: error instanceof Error ? error.message : String(error) })
      )
    }
  }
})
connection.start()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    connection.close()
    process.exit(0)
  })
}
