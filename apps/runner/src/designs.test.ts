import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packDesign, saveDesign } from './designs.ts'
import { exec } from './exec.ts'

describe('saveDesign', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-design-'))
  })

  afterEach(async () => {
    await exec('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true })
  })

  async function bundle(files: Record<string, string>): Promise<string> {
    const src = join(root, 'src')
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(src, name, '..'), { recursive: true })
      await writeFile(join(src, name), text)
    }
    const archive = join(root, 'bundle.tar')
    expect((await exec('tar', ['-cf', archive, '-C', src, '.'])).code).toBe(0)
    return (await readFile(archive)).toString('base64')
  }

  it('writes the spec and screenshots and extracts the bundle into the scratch folder', async () => {
    const scratch = join(root, 'scratch')
    const saved = await saveDesign(scratch, {
      taskRef: 'COR-7',
      version: 2,
      spec: '# Login\n\n## Screens\n- login\n',
      screenshots: [
        { fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png-1').toString('base64') },
        { fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png-2').toString('base64') }
      ],
      bundle: { dataBase64: await bundle({ 'index.html': '<h1>Login</h1>', 'assets/app.js': 'console.log(1)' }) }
    })
    expect(saved.ok).toBe(true)
    const dir = join(scratch, 'designs', 'COR-7-v2')
    const result = (saved as { result: Record<string, unknown> }).result
    expect(result).toEqual({
      taskRef: 'COR-7',
      version: 2,
      spec: '# Login\n\n## Screens\n- login\n',
      dir,
      specPath: join(dir, 'design.md'),
      screenshots: [
        { fileName: 'login.png', contentType: 'image/png', path: join(dir, 'screenshots', '01-login.png') },
        { fileName: 'login.png', contentType: 'image/png', path: join(dir, 'screenshots', '02-login.png') }
      ],
      bundle: { archive: join(dir, 'bundle.tar'), dir: join(dir, 'bundle'), index: join(dir, 'bundle', 'index.html') }
    })
    expect(await readFile(join(dir, 'design.md'), 'utf8')).toContain('## Screens')
    expect(await readFile(join(dir, 'screenshots', '02-login.png'), 'utf8')).toBe('png-2')
    expect(await readFile(join(dir, 'bundle', 'index.html'), 'utf8')).toBe('<h1>Login</h1>')
    expect(await readFile(join(dir, 'bundle', 'assets', 'app.js'), 'utf8')).toBe('console.log(1)')

    // Everything is read-only: a reference, not the agent's to change
    const entries = await readdir(dir, { recursive: true })
    for (const path of [dir, ...entries.map(e => join(dir, e))]) expect((await stat(path)).mode & 0o222, path).toBe(0)
  })

  it('replaces an earlier read-only copy of the same version', async () => {
    const scratch = join(root, 'scratch')
    const design = (spec: string) => ({ taskRef: 'COR-7', version: 1, spec, screenshots: [], bundle: { dataBase64: '' } })
    const archive = await bundle({ 'index.html': '<h1>Login</h1>' })
    expect(await saveDesign(scratch, { ...design('first'), bundle: { dataBase64: archive } })).toMatchObject({ ok: true })
    expect(await saveDesign(scratch, { ...design('second'), bundle: { dataBase64: archive } })).toMatchObject({ ok: true })
    expect(await readFile(join(scratch, 'designs', 'COR-7-v1', 'design.md'), 'utf8')).toBe('second')
  })

  it('reports a bundle that isn\'t a tar', async () => {
    const saved = await saveDesign(join(root, 'scratch'), { taskRef: 'COR-7', version: 1, spec: '', screenshots: [], bundle: { dataBase64: Buffer.from('not a tar').toString('base64') } })
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining('could not extract the design bundle') })
  })
})

// D20: what submit_design reads and packs before it pushes
describe('packDesign', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-pack-'))
    await mkdir(join(root, 'dist', 'assets'), { recursive: true })
    await writeFile(join(root, 'dist', 'index.html'), '<h1>Login</h1>')
    await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log(1)')
    await writeFile(join(root, 'design.md'), '# Login\n')
    await writeFile(join(root, 'login-desktop.png'), 'png')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const input = (over: Record<string, unknown> = {}) => ({ bundleDir: join(root, 'dist'), specPath: join(root, 'design.md'), screenshots: [join(root, 'login-desktop.png')], ...over })

  it('packs the bundle as a tar with index.html at its root, with the spec and screenshots', async () => {
    const packed = await packDesign(root, input())
    if (!packed.ok) throw new Error(packed.error)
    expect(packed.result).toMatchObject({ spec: '# Login\n', bundle: { files: 2 }, screenshots: [{ fileName: 'login-desktop.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64') }] })
    const archive = join(root, 'out.tar')
    await writeFile(archive, Buffer.from(packed.result.bundle.dataBase64, 'base64'))
    const listed = await exec('tar', ['-tf', archive])
    expect(listed.stdout.split('\n')).toEqual(expect.arrayContaining(['./index.html', './assets/app.js']))
  })

  it('resolves relative paths against the worktree', async () => {
    expect(await packDesign(root, input({ bundleDir: 'dist', specPath: 'design.md', screenshots: ['login-desktop.png'] }))).toMatchObject({ ok: true })
  })

  it('rejects a bundle without index.html at its root with a clear error', async () => {
    await mkdir(join(root, 'nested', 'dist'), { recursive: true })
    await writeFile(join(root, 'nested', 'dist', 'index.html'), '<h1>Login</h1>')
    expect(await packDesign(root, input({ bundleDir: join(root, 'nested') }))).toEqual({
      ok: false,
      error: `Not submitted. The bundle has no index.html at its root (${join(root, 'nested', 'index.html')}). Pass the folder that holds index.html and its assets, with relative paths.`
    })
  })

  it('rejects a missing folder, symlinks, a missing spec and non-image screenshots', async () => {
    expect(await packDesign(root, input({ bundleDir: join(root, 'nope') }))).toMatchObject({ ok: false, error: expect.stringContaining('No bundle folder') })
    expect(await packDesign(root, input({ specPath: join(root, 'missing.md') }))).toMatchObject({ ok: false, error: expect.stringContaining('No design.md') })
    expect(await packDesign(root, input({ screenshots: [] }))).toMatchObject({ ok: false, error: expect.stringContaining('at least one screenshot') })
    expect(await packDesign(root, input({ screenshots: [join(root, 'design.md')] }))).toMatchObject({ ok: false, error: expect.stringContaining('isn\'t a PNG') })
    await symlink('/etc/passwd', join(root, 'dist', 'leak.txt'))
    expect(await packDesign(root, input())).toMatchObject({ ok: false, error: expect.stringContaining('can\'t contain symlinks: leak.txt') })
  })
})
