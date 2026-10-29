// Ignore unsupported units, malformed ranges and multipart requests, serving the
// full representation instead. A valid single range with no bytes gets 416.
export function byteRange(header: string | undefined, size: number): { start: number, end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  // BigInt keeps arbitrarily large positions from rounding or overflowing.
  const length = BigInt(size)
  if (!match[1]) {
    const suffix = BigInt(match[2]!)
    if (suffix === 0n || length === 0n) return 'unsatisfiable'
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : length - 1n
  if (start >= length || end < start) return 'unsatisfiable'
  return { start: Number(start), end: Number(end >= length ? length - 1n : end) }
}
