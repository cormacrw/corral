// WAI-ARIA radio group: arrows select and focus, wrapping at either end.
export function moveRadioSelection(event: KeyboardEvent) {
  const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
  if (!direction || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'radio') return
  const radios = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  const index = radios.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const next = radios[(index + direction + radios.length) % radios.length]!
  next.click()
  next.focus()
}
