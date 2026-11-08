// Local calendar days, which Home, Agents and the run history count by

export const DAY_MS = 86_400_000

export const startOfDay = (at: number): number => {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export const sameDay = (iso: string | null, now: number | Date): boolean =>
  iso !== null && new Date(iso).toDateString() === new Date(now).toDateString()

// Rows for the last `days` local days, today last, and the row a time falls
// in. Days rather than 24h steps, so a clock change doesn't shift a row.
export function dayRows<T>(days: number, now: number, row: (date: Date, index: number) => T): { rows: T[], rowAt: (iso: string) => T | undefined } {
  const first = startOfDay(now) - (days - 1) * DAY_MS
  const rows = Array.from({ length: days }, (_, index) => row(new Date(first + index * DAY_MS), index))
  return { rows, rowAt: iso => rows[Math.round((startOfDay(Date.parse(iso)) - first) / DAY_MS)] }
}
