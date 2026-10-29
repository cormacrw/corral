import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { exec } from './exec.ts'

// What the server's get_design returns (D20): the files travel as base64
interface DesignFiles {
  taskRef: string
  version: number
  spec: string
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
  bundle: { dataBase64: string }
}

// Writes a design version into the agent's scratch folder, outside the
// repository: design.md, the screenshots and the static bundle, extracted,
// all read-only, since they're a reference and not the agent's to change.
// Returns what the server sent with the file contents swapped for their
// paths. The bundle is untrusted (D20): it's only unpacked here, never run
// by Corral.
export async function saveDesign(scratchDir: string, design: DesignFiles): Promise<{ ok: true, result: unknown } | { ok: false, error: string }> {
  const dir = join(scratchDir, 'designs', `${basename(design.taskRef)}-v${design.version}`)
  // An earlier copy is read-only, so make it writable to replace it
  if (await stat(dir).catch(() => null)) await exec('chmod', ['-R', 'u+w', dir])
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
  const archive = join(dir, 'bundle.tar')
  await writeFile(archive, Buffer.from(design.bundle.dataBase64, 'base64'))
  // GNU tar drops leading slashes and `..` members, so nothing lands outside
  const untar = await exec('tar', ['-xf', archive, '-C', bundleDir, '--no-same-owner', '--no-same-permissions'])
  if (untar.code !== 0) return { ok: false, error: `Corral could not extract the design bundle: ${untar.stderr.trim() || 'tar is missing'}` }
  await exec('chmod', ['-R', 'a-w', dir])

  return { ok: true, result: { ...design, dir, specPath, screenshots, bundle: { archive, dir: bundleDir, index: join(bundleDir, 'index.html') } } }
}

// What submit_design sends the server (D20): the bundle as a tar,
// design.md as text and the screenshots, all as base64
export interface DesignSubmission {
  bundle: { dataBase64: string, files: number }
  spec: string
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
}

export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024
const SCREENSHOT_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

// Reads what the developer passed to submit_design and packs the bundle.
// The bundle must have index.html at its root and no symlinks, so it works
// as static files on their own and can't point outside itself when unpacked.
export async function packDesign(baseDir: string, input: Record<string, unknown>): Promise<{ ok: true, result: DesignSubmission } | { ok: false, error: string }> {
  const at = (given: unknown) => isAbsolute(String(given)) ? String(given) : resolve(baseDir, String(given))
  const bundleDir = at(input.bundleDir ?? '')
  if (!input.bundleDir || !(await stat(bundleDir).catch(() => null))?.isDirectory()) return { ok: false, error: `Not submitted. No bundle folder at ${bundleDir}. Build the static bundle the way the project documents and pass its folder.` }
  if (!(await stat(join(bundleDir, 'index.html')).catch(() => null))?.isFile()) {
    return { ok: false, error: `Not submitted. The bundle has no index.html at its root (${join(bundleDir, 'index.html')}). Pass the folder that holds index.html and its assets, with relative paths.` }
  }
  const entries = await readdir(bundleDir, { recursive: true, withFileTypes: true })
  const links = entries.filter(e => e.isSymbolicLink())
  if (links.length > 0) return { ok: false, error: `Not submitted. The bundle can't contain symlinks: ${links.map(e => relative(bundleDir, join(e.parentPath, e.name))).join(', ')}. Copy the files in instead.` }

  const specPath = at(input.specPath ?? '')
  const spec = input.specPath ? await readFile(specPath, 'utf8').catch(() => null) : null
  if (!spec?.trim()) return { ok: false, error: `Not submitted. No design.md at ${specPath}. Write the spec and pass its path.` }

  const paths = Array.isArray(input.screenshots) ? input.screenshots.map(at) : []
  if (paths.length === 0) return { ok: false, error: 'Not submitted. Pass at least one screenshot per screen.' }
  const screenshots = []
  for (const path of paths) {
    const contentType = SCREENSHOT_TYPES[extname(path).toLowerCase()]
    if (!contentType) return { ok: false, error: `Not submitted. ${path} isn't a PNG, JPEG or WebP screenshot.` }
    const data = await readFile(path).catch(() => null)
    if (!data) return { ok: false, error: `Not submitted. No screenshot at ${path}.` }
    screenshots.push({ fileName: basename(path), contentType, dataBase64: data.toString('base64') })
  }

  const scratch = await mkdtemp(join(tmpdir(), 'corral-bundle-'))
  try {
    const archive = join(scratch, 'bundle.tar')
    const tar = await exec('tar', ['-cf', archive, '-C', bundleDir, '.'])
    if (tar.code !== 0) return { ok: false, error: `Corral could not pack the bundle: ${tar.stderr.trim() || 'tar is missing'}` }
    const data = await readFile(archive)
    if (data.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'Not submitted. The packed bundle is over 25 MB; leave out what the prototype doesn\'t need.' }
    return { ok: true, result: { bundle: { dataBase64: data.toString('base64'), files: entries.filter(e => e.isFile()).length }, spec, screenshots } }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
