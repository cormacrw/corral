import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundlePath, BundleError, packBundle, unpackBundle } from './bundle.ts'

const text = (s: string) => new TextEncoder().encode(s)

// macOS's tar has other format names, and adds ._ files unless told not to
const tarOptions = { env: { ...process.env, COPYFILE_DISABLE: '1' } }
const tarFormats = execFileSync('tar', ['--version']).includes('GNU tar') ? ['gnu', 'oldgnu', 'pax', 'posix'] : ['gnutar', 'pax']

const BLOCK = 512
const END = new Uint8Array(BLOCK * 2)

// One tar entry, with a valid checksum unless `edit` breaks the header after
function entry(name: string, body: Uint8Array | string = '', opts: { type?: string, edit?: (header: Uint8Array) => void } = {}): Uint8Array {
  const data = typeof body === 'string' ? text(body) : body
  const header = new Uint8Array(BLOCK)
  header.set(text(name).subarray(0, 100), 0)
  header.set(text('0000644\0'), 100)
  header.set(text('0000000\0'), 108)
  header.set(text('0000000\0'), 116)
  header.set(text(`${data.byteLength.toString(8).padStart(11, '0')}\0`), 124)
  header.set(text('00000000000\0'), 136)
  header.fill(0x20, 148, 156)
  header[156] = (opts.type ?? '0').charCodeAt(0)
  header.set(text('ustar\x0000'), 257)
  header.set(text(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `), 148)
  opts.edit?.(header)
  const padded = new Uint8Array(BLOCK + Math.ceil(data.byteLength / BLOCK) * BLOCK)
  padded.set(header)
  padded.set(data, BLOCK)
  return padded
}

function tar(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

function pax(path: string): Uint8Array {
  const body = ` path=${path}\n`
  const bytes = text(body).byteLength
  let length = bytes + 1
  while (String(length).length + bytes !== length) length = String(length).length + bytes
  return text(`${length}${body}`)
}

const failure = (archive: Uint8Array) => {
  try {
    unpackBundle(archive)
  } catch (error) {
    expect(error).toBeInstanceOf(BundleError)
    return (error as Error).message
  }
  return null
}

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
    const archive = execFileSync('tar', ['-cf', '-', '-C', src, '.'], tarOptions)
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

  it('skips links, folders and special files, whatever they point at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corral-bundle-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    symlinkSync('/etc/passwd', join(dir, 'link'))
    symlinkSync('index.html', join(dir, `${'l'.repeat(120)}`))
    linkSync(join(dir, 'index.html'), join(dir, 'hard'))
    mkdirSync(join(dir, 'folder'))
    const archive = new Uint8Array(execFileSync('tar', ['-cf', '-', '-C', dir, '.'], tarOptions))
    const paths = [...unpackBundle(archive).keys()]
    expect(paths).toHaveLength(1)
    expect(['index.html', 'hard']).toContain(paths[0])
    expect([...unpackBundle(tar(entry('link', '', { type: '2' }), entry('a.js', 'a'), END)).keys()]).toEqual(['a.js'])
  })

  it('skips unsafe names however they are carried, including empty ones', () => {
    const long = `../${'x'.repeat(120)}`
    const archive = tar(
      entry('././@LongLink', `${long}\0`, { type: 'L' }), entry('short'),
      entry('PaxHeader', pax(long), { type: 'x' }), entry('short'),
      entry(''),
      entry('ok.js', 'ok'),
      END
    )
    expect([...unpackBundle(archive).keys()]).toEqual(['ok.js'])
  })

  it('reads every format tar writes the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corral-bundle-'))
    const src = join(dir, 'src')
    const longFile = `${'a'.repeat(120)}/${'b'.repeat(120)}.js`
    const prefixed = `${'c'.repeat(80)}/${'d'.repeat(80)}.js`
    mkdirSync(join(src, 'c'.repeat(80)), { recursive: true })
    writeFileSync(join(src, 'index.html'), 'home')
    writeFileSync(join(src, prefixed), 'prefixed')
    const ustar = new Uint8Array(execFileSync('tar', ['--format=ustar', '-cf', '-', '-C', src, '.'], tarOptions))
    expect([...unpackBundle(ustar).keys()].sort()).toEqual(['index.html', prefixed].sort())
    expect(new TextDecoder().decode(unpackBundle(ustar).get(prefixed))).toBe('prefixed')

    mkdirSync(join(src, 'a'.repeat(120)))
    writeFileSync(join(src, longFile), 'long')
    for (const format of tarFormats) {
      const unpacked = unpackBundle(new Uint8Array(execFileSync('tar', [`--format=${format}`, '-cf', '-', '-C', src, '.'], tarOptions)))
      expect([...unpacked.keys()].sort(), format).toEqual(['index.html', prefixed, longFile].sort())
      expect(new TextDecoder().decode(unpacked.get(longFile)), format).toBe('long')
    }
  })

  it('accepts base-256 numbers, as GNU tar writes for a big uid', () => {
    const archive = tar(entry('a.js', 'a', {
      edit: (h) => {
        h.set([0x80, 0, 0, 0, 0, 0xff, 0xff, 0xff], 108)
        h.fill(0x20, 148, 156)
        h.set(text(`${h.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0')}\0 `), 148)
      }
    }), END)
    expect([...unpackBundle(archive).keys()]).toEqual(['a.js'])
  })

  it('reads pax records by their byte length, so multi-byte and newline values work', () => {
    expect(failure(tar(entry('g', '13 comment=x\n', { type: 'g' }), entry('a.js'), END))).toBeNull()
    const records = '13 comment=x\n19 foo=one\ntwo\nx=y\n'
    expect(failure(tar(entry('p', records, { type: 'x' }), entry('a.js'), END))).toBeNull()
    expect([...unpackBundle(tar(entry('p', pax('héllo/wörld.js'), { type: 'x' }), entry('x'), END)).keys()]).toEqual(['héllo/wörld.js'])
  })

  it('rejects a non-archive, naming where', () => {
    expect(failure(new Uint8Array([7]))).toBe('Truncated tar archive: entry 1 at offset 0 has 1 of 512 header bytes')
    expect(failure(new Uint8Array())).toBe('Truncated tar archive: no end-of-archive marker at offset 0 (entry 1)')
    expect(failure(new Uint8Array(BLOCK * 4).fill(0x41))).toMatch(/^Bad mode field in entry 1 .* at offset 0$/)
  })

  it('rejects a bad checksum, naming the entry, path and offset', () => {
    const archive = packBundle([{ path: 'index.html', data: text('x') }, { path: 'assets/app.js', data: text('y') }])
    archive[BLOCK * 2 + 3] = archive[BLOCK * 2 + 3]! ^ 1
    expect(failure(archive)).toBe('Bad header checksum in entry 2 ("assdts/app.js") at offset 1024')
  })

  it('rejects bad numeric fields', () => {
    const edit = (offset: number, value: string) => (h: Uint8Array) => h.set(text(value), offset)
    expect(failure(tar(entry('a.js', '', { edit: edit(124, '00000000009\0') }), END))).toBe('Bad size field in entry 1 ("a.js") at offset 0')
    expect(failure(tar(entry('a.js', '', { edit: edit(100, 'rw-r--r-') }), END))).toBe('Bad mode field in entry 1 ("a.js") at offset 0')
    expect(failure(tar(entry('a.js', '', { edit: edit(148, 'zzzzzz\0 ') }), END))).toBe('Bad checksum field in entry 1 ("a.js") at offset 0')
    expect(failure(tar(entry('a.js', '', { edit: edit(136, '0\0xxxxxxxxxx') }), END))).toBe('Bad mtime field in entry 1 ("a.js") at offset 0')
  })

  it('rejects truncation at every point', () => {
    const archive = packBundle([{ path: 'a.js', data: new Uint8Array(2000) }, { path: 'b.js', data: text('b') }])
    expect(failure(archive.subarray(0, 1024))).toBe('Truncated tar archive: entry 1 ("a.js") at offset 0 needs 2048 bytes of data, 512 left')
    expect(failure(archive.subarray(0, 2500))).toBe('Truncated tar archive: entry 1 ("a.js") at offset 0 needs 2048 bytes of data, 1988 left')
    expect(failure(archive.subarray(0, 2560 + 100))).toBe('Truncated tar archive: entry 2 at offset 2560 has 100 of 512 header bytes')
    // Cut on a block boundary: files would otherwise just go missing
    expect(failure(archive.subarray(0, 2560))).toBe('Truncated tar archive: no end-of-archive marker at offset 2560 (entry 2)')
    expect(failure(archive.subarray(0, 3584))).toBe('Truncated tar archive: no end-of-archive marker at offset 3584 (entry 3)')
    expect(failure(archive.subarray(0, 4096))).toBe('Truncated tar archive: incomplete end-of-archive marker at offset 3584')
    for (let cut = 0; cut < archive.byteLength; cut += 100) expect(failure(archive.subarray(0, cut)), String(cut)).not.toBeNull()
  })

  it('rejects data after the end-of-archive marker, and a zeroed block mid-archive', () => {
    const a = entry('a.js', 'a')
    expect(failure(tar(a, END, entry('b.js', 'b'), END))).toBe('Data after the end-of-archive marker at offset 1024')
    expect(failure(tar(a, new Uint8Array(BLOCK), entry('b.js', 'b'), END))).toBe('Data after the end-of-archive marker at offset 1024')
    expect(failure(tar(a, END, new Uint8Array(BLOCK * 8)))).toBeNull()
  })

  it('rejects bad extended headers', () => {
    const x = (body: string) => tar(entry('PaxHeader', body, { type: 'x' }), entry('a.js'), END)
    expect(failure(x('50 path=short\n'))).toBe('Bad pax record at byte 0 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(x('13 path=abc\n'))).toBe('Bad pax record at byte 0 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(x('abc path=x\n'))).toBe('Bad pax record at byte 0 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(x('0 path=x\n'))).toBe('Bad pax record at byte 0 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(x('8 nokey\n'))).toBe('Bad pax record at byte 0 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(x('12 path=abc\n8 nokey\n'))).toBe('Bad pax record at byte 12 of entry 1 ("PaxHeader") at offset 0')
    expect(failure(tar(entry('././@LongLink', '', { type: 'L' }), entry('a.js'), END))).toBe('Empty long name in entry 1 ("././@LongLink") at offset 0')
    expect(failure(tar(entry('././@LongLink', 'x\0', { type: 'L' }), END))).toBe('Extended header before offset 1024 has no entry to apply to')
  })

  it('rejects duplicate paths instead of letting one replace the other', () => {
    expect(failure(tar(entry('a.js', 'first'), entry('a.js', 'second'), END)))
      .toBe('Duplicate path "a.js": entry 2 ("a.js") at offset 1024 repeats entry 1 ("a.js") at offset 0')
    expect(failure(tar(entry('./a.js', 'first'), entry('a.js', 'second'), END)))
      .toBe('Duplicate path "a.js": entry 2 ("a.js") at offset 1024 repeats entry 1 ("./a.js") at offset 0')
    expect(failure(tar(entry('../a.js', 'unsafe'), entry('a.js', 'ok'), entry('a.js', '', { type: '2' }), END))).toBeNull()
  })
})
