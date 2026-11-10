// A design bundle archive for tests: plain ustar entries, so paths must fit
// in 100 bytes. The runner builds real bundles with `tar`.
const BLOCK = 512
const encoder = new TextEncoder()

export function packBundle(files: readonly { path: string, data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const { path, data } of files) {
    const header = new Uint8Array(BLOCK)
    const field = (offset: number, value: string) => header.set(encoder.encode(value), offset)
    const octal = (offset: number, length: number, value: number) => field(offset, `${value.toString(8).padStart(length - 1, '0')}\0`)
    field(0, path)
    octal(100, 8, 0o644)
    octal(108, 8, 0)
    octal(116, 8, 0)
    octal(124, 12, data.byteLength)
    octal(136, 12, 0)
    header.fill(0x20, 148, 156)
    field(156, '0')
    field(257, 'ustar\x0000')
    octal(148, 8, header.reduce((sum, b) => sum + b, 0))
    blocks.push(header, data, new Uint8Array((BLOCK - (data.byteLength % BLOCK)) % BLOCK))
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const out = new Uint8Array(blocks.reduce((sum, b) => sum + b.byteLength, 0))
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.byteLength
  }
  return out
}
