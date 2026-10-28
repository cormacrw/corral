import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The runner's stable ID, kept in <dataDir>/config.json (architecture.md,
// Layout on disk) so the server recognises it across restarts
export async function loadRunnerId(dataDir: string): Promise<string> {
  const path = join(dataDir, 'config.json')
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { runnerId?: unknown }
    if (typeof saved.runnerId === 'string') return saved.runnerId
  } catch {
    // First start: fall through and create one
  }
  const runnerId = randomUUID()
  await mkdir(dataDir, { recursive: true })
  await writeFile(path, JSON.stringify({ runnerId }, null, 2) + '\n')
  return runnerId
}
