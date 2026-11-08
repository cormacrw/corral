import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DESIGN_TOO_LARGE, DESIGN_VERSION_MAX_BYTES, megabytes, RUNNER_MAX_MESSAGE_BYTES, type DesignForAgent } from '@corral/contracts'
import { exec } from './exec.ts'

// What get_design returns once saved: the file contents swapped for their paths
export interface SavedDesign extends Omit<DesignForAgent, 'screenshots' | 'bundle'> {
  dir: string
  specPath: string
  screenshots: { fileName: string, contentType: string, path: string }[]
  bundle: { archive: string, dir: string, index: string }
}

// Writes a design version into the agent's scratch folder, outside the
// repository: design.md, the screenshots and the static bundle, extracted,
// all read-only, since they're a reference and not the agent's to change.
// The bundle is untrusted (D20): it's only unpacked here, never run by Corral.
export async function saveDesign(scratchDir: string, design: DesignForAgent): Promise<{ ok: true, result: SavedDesign } | { ok: false, error: string }> {
  const dir = join(scratchDir, 'designs', `${basename(design.taskRef)}-v${design.version}`)
  // An earlier copy is read-only
  await removeScratch(dir)
  const shots = join(dir, 'screenshots')
  const bundleDir = join(dir, 'bundle')
  await mkdir(shots, { recursive: true })
  await mkdir(bundleDir, { recursive: true })

  const specPath = join(dir, 'design.md')
  await writeFile(specPath, design.spec)
  const screenshots: SavedDesign['screenshots'] = []
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

// Removes a folder that may hold a read-only design copy, which plain rm
// can't empty: a run's or session's scratch folder, or an earlier copy
export async function removeScratch(path: string): Promise<void> {
  await exec('chmod', ['-R', 'u+w', path])
  await rm(path, { recursive: true, force: true })
}

// What submit_design sends the server (D20): the bundle as a tar,
// design.md as text and the screenshots, all as base64
interface DesignSubmission {
  bundle: { dataBase64: string, files: number }
  spec: string
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
}

// With the design version's limit, these keep the base64 message under the
// socket's limit
export const MAX_SPEC_BYTES = RUNNER_MAX_MESSAGE_BYTES / 20
export const MAX_SCREENSHOT_BYTES = RUNNER_MAX_MESSAGE_BYTES / 10
const BUNDLE_TOO_BIG = `Not submitted. The packed bundle is over ${megabytes(DESIGN_VERSION_MAX_BYTES)}; leave out what the prototype doesn't need.`
const SCREENSHOT_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

// Reads what the designer passed to submit_design and packs the bundle.
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

  // Sizes first: a folder holding node_modules must not reach tar or memory
  let bundleBytes = 0
  for (const entry of entries.filter(e => e.isFile())) {
    bundleBytes += (await stat(join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0
    if (bundleBytes > DESIGN_VERSION_MAX_BYTES) return { ok: false, error: BUNDLE_TOO_BIG }
  }

  const specPath = at(input.specPath ?? '')
  const specSize = input.specPath ? (await stat(specPath).catch(() => null))?.size ?? 0 : 0
  if (specSize > MAX_SPEC_BYTES) return { ok: false, error: `Not submitted. ${specPath} is over ${megabytes(MAX_SPEC_BYTES)}; design.md is a spec, not a place for assets.` }
  const spec = input.specPath ? await readFile(specPath, 'utf8').catch(() => null) : null
  if (!spec?.trim()) return { ok: false, error: `Not submitted. No design.md at ${specPath}. Write the spec and pass its path.` }

  const paths = Array.isArray(input.screenshots) ? input.screenshots.map(at) : []
  if (paths.length === 0) return { ok: false, error: 'Not submitted. Pass at least one screenshot per screen.' }
  const screenshots = []
  let screenshotBytes = 0
  for (const path of paths) {
    const contentType = SCREENSHOT_TYPES[extname(path).toLowerCase()]
    if (!contentType) return { ok: false, error: `Not submitted. ${path} isn't a PNG, JPEG or WebP screenshot.` }
    const size = (await stat(path).catch(() => null))?.size ?? 0
    screenshotBytes += size
    if (size > MAX_SCREENSHOT_BYTES) return { ok: false, error: `Not submitted. ${path} is over ${megabytes(MAX_SCREENSHOT_BYTES)}; capture a smaller screenshot.` }
    // The server takes a version only up to this, bundle and screenshots together
    if (bundleBytes + screenshotBytes > DESIGN_VERSION_MAX_BYTES) return { ok: false, error: DESIGN_TOO_LARGE }
    const data = await readFile(path).catch(() => null)
    if (!data) return { ok: false, error: `Not submitted. No screenshot at ${path}.` }
    screenshots.push({ fileName: basename(path), contentType, dataBase64: data.toString('base64') })
  }

  const scratch = await mkdtemp(join(tmpdir(), 'corral-bundle-'))
  try {
    const archive = join(scratch, 'bundle.tar')
    const tar = await exec('tar', ['-cf', archive, '-C', bundleDir, '.'])
    if (tar.code !== 0) return { ok: false, error: `Corral could not pack the bundle: ${tar.stderr.trim() || 'tar is missing'}` }
    const packed = (await stat(archive)).size
    if (packed > DESIGN_VERSION_MAX_BYTES) return { ok: false, error: BUNDLE_TOO_BIG }
    if (packed + screenshotBytes > DESIGN_VERSION_MAX_BYTES) return { ok: false, error: DESIGN_TOO_LARGE }
    const data = await readFile(archive)
    return { ok: true, result: { bundle: { dataBase64: data.toString('base64'), files: entries.filter(e => e.isFile()).length }, spec, screenshots } }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
