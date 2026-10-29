import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundlePath, packBundle, unpackBundle } from './bundle.ts'

const text = (s: string) => new TextEncoder().encode(s)

describe('bundlePath', () => {
  it('keeps relative paths and maps folders to their index.html', () => {
    expect(bundlePath('')).toBe('index.html')
    expect(bundlePath('index.html')).toBe('index.html')
    expect(bundlePath('assets/app.js')).toBe('assets/app.js')
    expect(bundlePath('screens/')).toBe('screens/index.html')
    expect(bundlePath('.well-known/x.json')).toBe('.well-known/x.json')
  })

  it('refuses anything that could leave the bundle', () => {
    for (const raw of ['..', '../secret', 'assets/../../etc/passwd', 'a/./b', './index.html', '/etc/passwd', '//etc/passwd', 'a//b', 'C:/Windows', 'c:x', '..\\x', 'a\\b', 'a\0b', 'a\nb']) {
      expect(bundlePath(raw), raw).toBeNull()
    }
  })
})

describe('bundle archives', () => {
  it('round-trips files, including long paths', () => {
    const long = `${'deep/'.repeat(30)}file.js`
    const files = [
      { path: 'index.html', data: text('<h1>Hi</h1>') },
      { path: 'assets/app.js', data: new Uint8Array(1500).fill(7) },
      { path: long, data: text('long') },
      { path: 'empty.txt', data: new Uint8Array() }
    ]
    const archive = packBundle(files)
    expect(archive.byteLength % 512).toBe(0)
    const unpacked = unpackBundle(archive)
    expect([...unpacked.keys()]).toEqual(['index.html', 'assets/app.js', long, 'empty.txt'])
    for (const f of files) expect(unpacked.get(f.path)).toEqual(f.data)
  })

  it('reads archives written by tar, and tar reads ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corral-bundle-'))
    const src = join(dir, 'dist')
    mkdirSync(join(src, 'assets', 'x'.repeat(90)), { recursive: true })
    writeFileSync(join(src, 'index.html'), '<p>tar</p>')
    writeFileSync(join(src, 'assets', 'x'.repeat(90), 'y'.repeat(40) + '.css'), 'p{}')
    const archive = execFileSync('tar', ['-cf', '-', '-C', src, '.'])
    const unpacked = unpackBundle(new Uint8Array(archive))
    expect(new TextDecoder().decode(unpacked.get('index.html'))).toBe('<p>tar</p>')
    expect(new TextDecoder().decode(unpacked.get(`assets/${'x'.repeat(90)}/${'y'.repeat(40)}.css`))).toBe('p{}')

    const ours = join(dir, 'ours.tar')
    const long = `${'z'.repeat(120)}.js`
    writeFileSync(ours, packBundle([{ path: 'a/b.txt', data: text('b') }, { path: long, data: text('l') }]))
    const out = join(dir, 'out')
    mkdirSync(out)
    execFileSync('tar', ['-xf', ours, '-C', out])
    expect(readFileSync(join(out, 'a/b.txt'), 'utf8')).toBe('b')
    expect(readFileSync(join(out, long), 'utf8')).toBe('l')
  })

  it('skips entries whose names would leave the bundle', () => {
    const archive = packBundle([
      { path: '../evil.js', data: text('x') },
      { path: '/etc/passwd', data: text('x') },
      { path: 'ok.js', data: text('ok') }
    ])
    expect([...unpackBundle(archive).keys()]).toEqual(['ok.js'])
  })

  it('throws on a truncated archive', () => {
    const archive = packBundle([{ path: 'a.js', data: new Uint8Array(2000) }])
    expect(() => unpackBundle(archive.subarray(0, 1024))).toThrow()
  })
})
