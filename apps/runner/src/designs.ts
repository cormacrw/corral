import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { exec } from './exec.ts'

// What the server's get_design returns (D20): the files travel as base64
interface DesignFiles {
  taskRef: string
  version: number
  spec: string
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
  bundle: { dataBase64: string }
}

// Writes a design version into the agent's scratch folder: design.md, the
// screenshots and the static bundle, extracted. Returns what the server sent
// with the file contents swapped for their paths. The bundle is untrusted
// (D20): it's only unpacked here, never run by Corral.
export async function saveDesign(scratchDir: string, design: DesignFiles): Promise<{ ok: true, result: unknown } | { ok: false, error: string }> {
  const dir = join(scratchDir, 'designs', `${basename(design.taskRef)}-v${design.version}`)
  await rm(dir, { recursive: true, force: true })
  const shots = join(dir, 'screenshots')
  const bundleDir = join(dir, 'bundle')
  await mkdir(shots, { recursive: true })
  await mkdir(bundleDir, { recursive: true })

  const specPath = join(dir, 'design.md')
  await writeFile(specPath, design.spec)
  const screenshots = []
  for (const [i, shot] of design.screenshots.entries()) {
    // Two screenshots may share a name; neither may leave the folder
    const path = join(shots, `${String(i + 1).padStart(2, '0')}-${basename(shot.fileName)}`)
    await writeFile(path, Buffer.from(shot.dataBase64, 'base64'))
    screenshots.push({ fileName: shot.fileName, contentType: shot.contentType, path })
  }
  const archive = join(dir, 'bundle.tar.gz')
  await writeFile(archive, Buffer.from(design.bundle.dataBase64, 'base64'))
  // GNU tar drops leading slashes and `..` members, so nothing lands outside
  const untar = await exec('tar', ['-xzf', archive, '-C', bundleDir, '--no-same-owner', '--no-same-permissions'])
  if (untar.code !== 0) return { ok: false, error: `Corral could not extract the design bundle: ${untar.stderr.trim() || 'tar is missing'}` }

  return { ok: true, result: { ...design, specPath, screenshots, bundle: { archive, dir: bundleDir, index: join(bundleDir, 'index.html') } } }
}
