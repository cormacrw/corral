import { loadConfig } from './config.ts'

const config = loadConfig()

// The WebSocket connection to the server comes next; for now the runner only
// checks its configuration and exits.
console.log(`corral runner configured for ${config.serverUrl.href} (data: ${config.dataDir})`)
