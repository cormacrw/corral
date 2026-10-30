// The browser history position of Corral's earliest entry in this tab. Tab
// taps on mobile (design/mobile.md) go back to it, never past it: entries
// before it may belong to other sites. vue-router numbers a fresh tab's first
// entry history.length - 1, not 0, and a reload keeps the old numbering, so
// the start is the position Corral loaded on, lowered whenever a popstate
// lands earlier (a popstate within the page is always one of Corral's entries).
let start: number | undefined

export function recordAppHistoryPosition(position: unknown) {
  if (typeof position !== 'number') return
  if (start === undefined || position < start) start = position
}

// How many entries back Corral's first entry is from the given position
export function stepsToAppStart(position: unknown) {
  if (typeof position !== 'number' || start === undefined) return 0
  return Math.max(0, position - start)
}

export function resetAppHistory() {
  start = undefined
}
