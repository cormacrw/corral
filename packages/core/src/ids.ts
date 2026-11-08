// A UUID as Postgres writes it, for building larger patterns
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i')

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A commit as people read it in messages and history
export function shortSha(sha: string | null): string {
  return sha?.slice(0, 10) ?? 'unknown'
}

// Text cut to at most `max` characters, ending in an ellipsis when cut
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
