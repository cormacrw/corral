import { homedir } from 'node:os'
import { styleText } from 'node:util'

// The startup message, styled like Nuxt's so the three apps read alike under
// turbo. styleText drops the colours when stdout isn't a terminal or NO_COLOR is set.
export function printReady(title: string, rows: Record<string, string>): void {
  const width = Math.max(...Object.keys(rows).map(label => label.length)) + 1
  const lines = [
    `${styleText('green', '✔')} ${styleText('bold', title)}`,
    ...Object.entries(rows).map(([label, value]) =>
      `  ${styleText('green', '➜')} ${styleText('bold', `${label}:`.padEnd(width))}  ${styleText('cyan', value)}`)
  ]
  console.log(lines.join('\n'))
}

export function shortenHome(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

// Shows where Postgres is without ever printing the password
export function redactUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.password) parsed.password = '***'
  return parsed.href
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}
