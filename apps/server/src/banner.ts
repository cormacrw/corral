// Server-only startup details; the shared banner is @corral/contracts/banner

// Shows where Postgres is without ever printing the password
export function redactUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.password) parsed.password = '***'
  return parsed.href
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}
