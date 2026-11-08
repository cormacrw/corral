import { errorText } from '@corral/core'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readIfExists } from './layout.ts'

// The runner's stable ID, kept in <dataDir>/config.json (architecture.md,
// Layout on disk) so the server recognises it across restarts. Only a missing
// file means a first start: a file that can't be read or parsed stops the
// runner rather than replace its ID, which would lose its runs and affinity.
export async function loadRunnerId(dataDir: string): Promise<string> {
  const path = join(dataDir, 'config.json')
  const text = await readIfExists(path)
  let saved: Record<string, unknown> = {}
  if (text !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`${path} is not valid JSON (${errorText(error)}). Fix or remove it; removing it gives this runner a new ID.`, { cause: error })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`)
    saved = parsed as Record<string, unknown>
    if (typeof saved.runnerId === 'string') return saved.runnerId
  }
  const runnerId = randomUUID()
  await mkdir(dataDir, { recursive: true })
  await writeFile(path, JSON.stringify({ ...saved, runnerId }, null, 2) + '\n')
  return runnerId
}
