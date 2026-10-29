// Keep the familiar repo abbreviation where possible, then extend it. The
// server remains authoritative: another browser can create a project meanwhile.
export function suggestPrefix(name: string, prefixes: string[]): string {
  const used = new Set(prefixes)
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '').padEnd(2, 'X')
  for (let length = Math.min(3, letters.length); length <= Math.min(5, letters.length); length++) {
    const candidate = letters.slice(0, length)
    if (!used.has(candidate)) return candidate
  }
  // Exhaustive fallback also handles short or entirely non-letter repo names.
  for (let number = 0; number < 26 ** 5; number++) {
    let rest = number
    let candidate = ''
    for (let digit = 0; digit < 5; digit++) {
      candidate = String.fromCharCode(65 + rest % 26) + candidate
      rest = Math.floor(rest / 26)
    }
    if (!used.has(candidate)) return candidate
  }
  throw new Error('No task ID prefixes available.')
}
