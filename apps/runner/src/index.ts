import { printReady, shortenHome } from './banner.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()

// The WebSocket connection to the server comes next; for now the runner only
// checks its configuration and exits.
printReady('Corral runner started', {
  Server: config.serverUrl.href,
  Data: shortenHome(config.dataDir)
})
