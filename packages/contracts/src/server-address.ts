// Where the server listens when nothing says otherwise. Docker Compose and the
// images set the same port (docker-compose.yml, apps/server/Dockerfile).
export const DEFAULT_SERVER_PORT = 4100
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`

// What `pnpm dev` writes for this checkout's instance, relative to the repo
// root, so tools and agents can find it
export const DEV_INSTANCE_FILE = '.corral/dev.json'
export interface DevInstance {
  pid: number
  webUrl: string
  serverUrl: string
  serverDataDir: string
  runnerDataDir: string
  demo: boolean
}
