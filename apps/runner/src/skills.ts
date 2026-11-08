import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_RUNTIMES, errorText, type CliId } from '@corral/core'
import type { Runtimes } from './runtimes.ts'

// The skills pinned in apps/runner/skills (see UPSTREAM.md there)
export const pinnedSkillsDir = fileURLToPath(new URL('../skills', import.meta.url))

interface SkillTarget {
  cli: CliId
  dir: string
}

// The user-skills directory each agent CLI reads. ~/.claude and ~/.codex are
// volumes in Docker, so the skills are written there at startup rather than
// baked into the image.
export function skillTargets(runtimes: Runtimes): SkillTarget[] {
  return [...runtimes.registry.values()].map(runtime => ({ cli: AGENT_RUNTIMES[runtime.id], dir: runtime.skillsDir }))
}

// Copies each skill directory in sourceDir into every target, writing only the
// files whose contents differ. Nothing else in the targets is read, changed or
// removed. A target that can't be written gets a warning and is skipped, so a
// read-only volume never stops the runner.
export async function installSkills(
  sourceDir: string,
  targets: SkillTarget[],
  warn: (message: string) => void = message => console.warn(`Warning: ${message}`)
): Promise<void> {
  const files = await skillFiles(sourceDir)
  for (const target of targets) {
    try {
      for (const [path, contents] of files) {
        const destination = join(target.dir, path)
        if (await sameContents(destination, contents)) continue
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, contents)
      }
    } catch (error) {
      warn(`could not install skills for ${target.cli} in ${target.dir}: ${errorText(error)}`)
    }
  }
}

// Every file under sourceDir's subdirectories, keyed by its path relative to sourceDir
async function skillFiles(sourceDir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  for (const entry of await readdir(sourceDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = relative(sourceDir, join(entry.parentPath, entry.name))
    if (dirname(path) === '.') continue
    files.set(path, await readFile(join(entry.parentPath, entry.name)))
  }
  return files
}

async function sameContents(path: string, contents: Buffer): Promise<boolean> {
  try {
    return (await readFile(path)).equals(contents)
  } catch {
    return false
  }
}
