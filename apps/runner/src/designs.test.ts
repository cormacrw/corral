import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveDesign } from './designs.ts'
import { exec } from './exec.ts'

describe('saveDesign', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-design-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function bundle(files: Record<string, string>): Promise<string> {
    const src = join(root, 'src')
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(src, name, '..'), { recursive: true })
      await writeFile(join(src, name), text)
    }
    const archive = join(root, 'bundle.tar.gz')
    expect((await exec('tar', ['-czf', archive, '-C', src, '.'])).code).toBe(0)
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
      specPath: join(dir, 'design.md'),
      screenshots: [
        { fileName: 'login.png', contentType: 'image/png', path: join(dir, 'screenshots', '01-login.png') },
        { fileName: 'login.png', contentType: 'image/png', path: join(dir, 'screenshots', '02-login.png') }
      ],
      bundle: { archive: join(dir, 'bundle.tar.gz'), dir: join(dir, 'bundle'), index: join(dir, 'bundle', 'index.html') }
    })
    expect(await readFile(join(dir, 'design.md'), 'utf8')).toContain('## Screens')
    expect(await readFile(join(dir, 'screenshots', '02-login.png'), 'utf8')).toBe('png-2')
    expect(await readFile(join(dir, 'bundle', 'index.html'), 'utf8')).toBe('<h1>Login</h1>')
    expect(await readFile(join(dir, 'bundle', 'assets', 'app.js'), 'utf8')).toBe('console.log(1)')
  })

  it('reports a bundle that isn\'t a gzipped tar', async () => {
    const saved = await saveDesign(join(root, 'scratch'), { taskRef: 'COR-7', version: 1, spec: '', screenshots: [], bundle: { dataBase64: Buffer.from('not a tar').toString('base64') } })
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining('could not extract the design bundle') })
  })
})
